# DeepSeek Harness 工具注入完整实现拆解

> 本文档系统拆解 DSH 工具注入的全链路：从工具定义、注册、发现、组装到系统提示词注入和模型请求构建。

---

## 目录

1. [架构总览](#一架构总览)
2. [工具定义层：defineTool](#二工具定义层definetool)
3. [工具注册与作用域层：ToolRuntime](#三工具注册与作用域层toolruntime)
4. [系统提示词注入层：SystemPrompt](#四系统提示词注入层systemprompt)
5. [执行管线层：pre/execute/post 瀑布](#五执行管线层preexecutepost-瀑布)
6. [PTC 模式层：run_code 与 SDK 生成](#六ptc-模式层run_code-与-sdk-生成)
7. [MCP 外部工具注入](#七mcp-外部工具注入)
8. [Agent Instructions 注入](#八agent-instructions-注入)
9. [真实工具注册示例](#九真实工具注册示例)
10. [全链路数据流图](#十全链路数据流图)

---

## 一、架构总览

DSH 工具注入是一个**五层架构**，每层职责明确、接口清晰：

```
┌─────────────────────────────────────────────────────┐
│  Layer 5: Agent Loop (packages/core/agent-loop)      │
│  调用 systemPrompt.assemble() → renderPrompt()       │
│  → buildRequest(tools) → LLM API                     │
├─────────────────────────────────────────────────────┤
│  Layer 4: System Prompt (packages/core/system-prompt) │
│  section() / context() / tools() / variable()         │
│  assemble() → PromptAssembly → renderPrompt()         │
├─────────────────────────────────────────────────────┤
│  Layer 3: Tool Runtime (packages/core/tools)          │
│  register() / restrict() / guard() / view()           │
│  execute → pre-execute → execute → post-execute       │
├─────────────────────────────────────────────────────┤
│  Layer 2: Tool Definition (packages/core/tools/schema) │
│  defineTool<S, O>() → ToolDefinition                   │
│  ValueSchemaSpec / ParameterSchemaSpec / InferArgs     │
├─────────────────────────────────────────────────────┤
│  Layer 1: Cordis Plugin System (vendor/cordis)        │
│  Service / Context / effect() / ScopedLayers           │
└─────────────────────────────────────────────────────┘
```

**核心数据流**：

```
defineTool() → ToolDefinition
    ↓
ctx.tools.register(definition) → ScopedLayers<ToolLayer> → emit tools/change
    ↓
ToolRuntime.wireSchemas(scope) → ToolSchema[]  (注册为 systemPrompt.tools provider)
    ↓
SystemPrompt.assemble() → PromptAssembly { sections, contexts, tools, variables }
    ↓
renderPrompt(assembly) → 系统提示词文本
assembly.tools → buildRequest() → GenerateOptions.tools → LLM API tools 参数
    ↓
模型返回 ToolCallBlock → executeToolCalls() → ToolRuntime.execute() → 管线执行
```

---

## 二、工具定义层：defineTool

> 源码：`packages/core/tools/src/schema.ts`

### 2.1 defineTool 签名

```typescript
export function defineTool<
  const S extends ParameterSchemaSpec,
  const O extends ValueSchemaSpec
>(options: DefineToolOptions<S, O>): ToolDefinition
```

**双泛型设计**：
- **S**（ParameterSchemaSpec）：参数 schema，用 `const` 保证字面量类型精确推断
- **O**（ValueSchemaSpec）：输出值 schema，同样 `const` 保证精度

**NoInfer 隔离**：在 `output.render`、`execute` 等回调中，O 被 `NoInfer` 包裹，防止回调参数的反向类型推断污染 O 的声明类型。

### 2.2 DefineToolOptions 完整结构

| 字段 | 类型 | 用途 |
|------|------|------|
| name | string | 工具名（模型调用标识） |
| description | string | 模型可见描述 |
| parameters | ParameterSchemaSpec | 参数 DSL |
| output.schema | ValueSchemaSpec | 输出值 DSL |
| output.render | (args, value) => ContentBlock[] | 结构化值 → 模型可见文本 |
| output.presentationMeta? | (args, value) => JsonValue | 持久化 UI 元数据 |
| execute | (args, exec) => Promise<JsonValue> | 执行体 |
| timeoutMs? | number | 协作式超时（ms） |
| isConcurrencySafe? | (args) => boolean | 可否并行 |
| presentCall? | (args) => ToolCallView | 调用时 UI 展示 |
| presentResult? | (args, result) => ToolResultView | 结果 UI 展示 |
| projectContent? | (exec, result) => ContentBlock[]? | 执行预备内容投影 |
| finalizeContent? | (exec, result) => ContentBlock[]? | 内容终态化 |
| deferLoading? | true | 延迟加载标志 |

### 2.3 ValueSchemaSpec 类型体系

9 种值 schema 类型构成完整 DSL：

| 类型 | type 字段 | 特有能力 |
|------|-----------|----------|
| StringValueSchemaSpec | 'string' | enum, const |
| NumberValueSchemaSpec | 'number' | enum, const |
| IntegerValueSchemaSpec | 'integer' | enum, const |
| BooleanValueSchemaSpec | 'boolean' | enum, const |
| NullValueSchemaSpec | 'null' | enum, const |
| ArrayValueSchemaSpec | 'array' | items 递归 |
| ObjectValueSchemaSpec | 'object' | properties 递归, additionalProperties |
| JsonValueSchemaSpec | 'json' | 无约束（作者专用） |
| OneOfValueSchemaSpec | 无 | oneOf: [至少2个分支] |

### 2.4 类型推断

```typescript
// 从 schema 推断 TypeScript 类型
InferValue<{ type: 'string', const: 'foo' }>           → "foo"
InferValue<{ type: 'string', enum: ['a','b'] }>        → "a" | "b"
InferValue<{ type: 'object', additionalProperties: false, properties: { x: { type: 'number' } } }>
                                                        → { x?: number }
InferArgs<{ name: { type: 'string', required: true }, age: { type: 'integer' } }>
                                                        → { name: string, age?: number }
```

深度限制 16 层，超出退化为 `JsonValue`。

### 2.5 编译流程

```
作者 DSL (ValueSchemaSpec)
    ↓  runSchemaCompiler() — 栈安全迭代编译器
JSON Schema (JsonSchemaNode)
    ↓  assertSupportedJsonSchema() — 关键字白名单+语义约束
合规 JSON Schema → 赋给 tool.parameters / tool.output.schema
```

**栈安全**：编译和校验均用迭代式任务栈，避免深层嵌套溢出。
**关键字白名单**：只接受 type/oneOf/properties/required/additionalProperties/items/enum/const + 4 个注解关键字，其余一律拒绝。

### 2.6 execute 包装

`defineTool` 内部在用户 `execute` 前插入 schema 验证：
- 违反 → throw ToolArgsError(violations)
- 通过 → userExecute(args as InferArgs<S>)

**presentCall/presentResult 软校验**：重放旧 schema 参数时验证失败返回 undefined（降级为通用卡片），而非抛错。

---

## 三、工具注册与作用域层：ToolRuntime

> 源码：`packages/core/tools/src/index.ts`

### 3.1 ToolRuntime 类

```typescript
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']
  // ...
}
```

核心持有 `ScopedLayers<ToolLayer>` 分层容器，实现全局/作用域两级注册。

### 3.2 ScopedLayers 分层结构

```
global 层 (所有 agent 共享)
  ├── tools: NamedEntries<ToolDefinition>
  ├── restrictions: AnonymousEntries<CompiledToolRestriction>
  ├── guards: AnonymousEntries<ToolGuard>
  └── mode: ToolPresentationMode | undefined

scoped 层 (每个 agent 独有, 按 ScopeKey 索引)
  ├── tools: NamedEntries<ToolDefinition>
  ├── restrictions: AnonymousEntries<CompiledToolRestriction>
  ├── guards: AnonymousEntries<ToolGuard>
  └── mode: ToolPresentationMode | undefined
```

**链遍历**：`chainLayers(scope)` 从最远祖先到自身收集层，后出现的层（更近的）可以覆盖更远的（shadow 语义）。

### 3.3 register(definition) 流程

```
register(ToolDefinition)
  ├─ 1. 校验 output：必须声明 { schema, render, presentationMeta? }
  ├─ 2. 校验 output.schema：assertSupportedJsonSchema
  ├─ 3. 校验 timeoutMs：正有限数
  ├─ 4. 保留名检查：name === 'run_code' → 抛错
  └─ 5. layers.effect(ctx, layer => layer.tools.insert(name, definition))
       ├─ scopeOf(ctx) 确定 scope
       ├─ NamedEntries.insert → 同名抛 duplicateError
       └─ emit('tools/change')
```

**关键语义**：
- 全局注册 → 写入 global 层
- 作用域注册（agent.ctx）→ 写入 scoped 层，同名覆盖全局（shadow）
- 返回精确 dispose 函数，撤销时若层变空则清理

### 3.4 restrict(filter) 作用域限制

```
restrict({ allow?, deny? })
  ├─ 1. 必须有 scope（全局 restriction 会掩盖所有 agent）
  ├─ 2. allow/deny 至少传一个
  ├─ 3. 编译为 Set
  ├─ 4. 保留名和已知名校验
  └─ 5. layers.effect → layer.restrictions.append
```

**核心设计**：restriction 只过滤**继承的**全局工具，**不过滤自身层的注册**。保证子 agent 的自有工具（如结构化输出工具）不会被自身的 allow 过滤掉。多条 restriction 交叉（intersect）：链上任何一层拒绝即不可见。

### 3.5 guard(guardFn) 单调守卫

- **单调性**：只能拒绝（返回 reason 字符串），无法放行
- **评估顺序**：全局层先 → scope 链远→近，首个拒绝即止
- **不触发 tools/change**（notify=false）
- 执行时序：在 tools/pre-execute waterfall 之后、工具体之前

### 3.6 view(scope) 完整视图解析

```
view(scope?)
  ├─ 1. chainLayers(scope) → 链上所有层（远→近）
  ├─ 2. inherited Map：从 global.tools 开始，逐层合并（近层 shadow 远层）
  ├─ 3. 过滤 inherited → visible：
  │     每个名字必须被所有层的 layer.admits(name) 放行
  ├─ 4. 叠加 own 层注册：不受 restriction 过滤（自身豁免）
  └─ 5. PTC 传输注入：若 mode !== 'native' → visible.set('run_code', ptcTransport)
```

返回 `ToolView { visible, knownNames, restrictableNames }`。

### 3.7 modeFor(scope) 展示模式

沿 chainLayers 从近到远查找首个非 undefined 的 mode，未找到则使用 defaultMode（Config.mode）。允许 agent preset 为旗下 agent 声明 PTC 模式。

---

## 四、系统提示词注入层：SystemPrompt

> 源码：`packages/core/system-prompt/src/index.ts`

### 4.1 四个注册原语

| 方法 | 注册内容 | 用途 |
|------|----------|------|
| section(PromptSection) | 有序文本段落 | 工具使用指导、身份声明、规则 |
| context(PromptContext) | 动态上下文 | 运行时快照（工作目录、沙箱策略等） |
| tools(provider) | 工具 schema 提供者 | 注入 ToolSchema[] 到 assembly |
| variable(name, provider) | 插值变量 | `{{variable}}` 模板替换 |

### 4.2 SECTION_ORDERS 顺序表

```
HARNESS_IDENTITY:     -1000  → "You are an AI agent powered by DeepSeek Harness."
DEPLOYMENT_PERSONA:   0      → 部署方自定义前缀
PLAN_POLICY:          500
TEAM_POLICY:          600
PTC_ONLY:             800    → "run_code is the only tool you can call directly"
FILE_REFERENCE:       900
TOOL_BASH:            1000   → bash 工具使用指导
TOOL_PWSH:            1010
TOOL_READ:            1100
TOOL_WRITE:           1200
TOOL_EDIT:            1300
TOOL_GLOB:            1400
TOOL_GREP:            1500
TOOL_JOBS:            1600
TOOL_PTY:             1700
TOOL_WEB_SEARCH:      2000
TOOL_WEB_FETCH:       2100
TOOL_LSP:             2200
TOOL_SESSION_QUERY:   2300
TOOL_GOAL:            2400
TOOL_WORKFLOW:        2600
TOOL_RALPH:           2700
TOOL_SUBAGENT:        2800
TOOL_REPORT:          2900
TOOL_COMPUTER_USE:    3000
MCP_SERVERS:          3100
TOOLS_SDK:            5000   → PTC 模式生成的 SDK 声明
DELIVERABLE_FILE_REF: 9000
STRUCTURED_OUTPUT:    9900
HARNESS_SOURCE:       10000
WEB_SURFACE:          10100
DEPLOYMENT_PERSONA_SUFFIX: 10200
```

每个工具通过 `ctx.systemPrompt.section()` 在固定 order 位置注入使用指导。PTC 模式的 SDK 声明在 5000，位于所有工具指导之后。

### 4.3 assemble() 完整流程

```
SystemPrompt.assemble(context: AssembleContext)
  ├─ 1. 合并全局+作用域 sections/contexts/variables
  │     sections: scoped shadow global（同名覆盖）
  │     variables: scoped shadow global
  │     contexts: 按层合并
  ├─ 2. 调用所有 toolProviders 收集 ToolSchema
  │     全局 providers + scope 链上 providers
  │     → collected: ToolSchema[], knownNames: Set<string>
  ├─ 3. orderTools(collected, toolOrder, knownNames)
  │     按 Config.toolOrder 排序，未列出的插在 <unlisted-tools> 位置
  │     无 toolOrder → 按名字字典序
  ├─ 4. 组装 PromptAssembly { sections, contexts, tools, variables }
  ├─ 5. 运行 system-prompt/assemble 瀑布（可扩展）
  └─ 6. 处理 complete section + runtimeContext 抑制
```

### 4.4 wireSchemas() — 工具 Schema 如何进入 Assembly

`ToolRuntime` 构造时注册：

```typescript
ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
```

`wireSchemas(scope)` 的逻辑：

| 模式 | 返回 schemas | knownNames |
|------|-------------|------------|
| native | 所有 visible 工具的 ToolSchema | 所有已知名 |
| ptc | 只有 run_code 的 ToolSchema | ['run_code'] |

### 4.5 从 Assembly 到 LLM 请求

`agent.ts` 的 `step()` 方法中：

```
preStep()
  ├─ ctx.systemPrompt.assemble(assembleContextFor(this, signal))
  ├─ renderContextSections(assembly) → 运行时上下文段落
  └─ runtimeContext.project() → 运行时快照 user message

step()
  ├─ renderPrompt(assembly) → 渲染系统提示词文本
  ├─ systemPrompt.project(renderedPrompt, intent)
  │     → session.append('system/message', ...)
  ├─ session.append('user/message', context)  → 运行时上下文注入
  └─ buildRequest(config, preparedCall, assembly.tools, ...)
        ├─ assembly.tools → canonicalHeader({ tools })
        ├─ session.append('request/header', { header, tools })
        │     工具变更时追加 tool-addition/tool-removal developer message
        └─ { ...header.config, messages, tools: header.tools } → GenerateOptions
              → ctx.llm.stream(request) → 发送给 LLM
```

**关键**：`assembly.tools` 直接成为 LLM API 的 `tools` 参数。工具的 name/description/parameters 三个字段构成模型可见的完整工具 schema。

---

## 五、执行管线层：pre/execute/post 瀑布

> 源码：`packages/core/agent-loop/src/tool-calls.ts` + `packages/core/tools/src/index.ts`

### 5.1 调度层（tool-calls.ts）

模型返回 ToolCallBlock[] 后，`executeToolCalls()` 的调度逻辑：

```
executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext)
  ├─ 为每个 toolCall 构建 PlannedCall { block, exec: ToolExecutionInput }
  ├─ 逐组调度：
  │   ├─ 查询 ctx.tools.executionMode(first) → 'parallel' | 'exclusive'
  │   ├─ parallel: 所有后续调用归入一组
  │   ├─ exclusive: 仅当前调用归入一组
  │   └─ runGroup() → 有界并行池 + model-order 结果提交
  ├─ 中止时：未启动调用记录 ABORTED_BEFORE_DISPATCH
  └─ 返回 { concluded: boolean }
```

### 5.2 ToolRuntime 管线

```
execute(input: ToolExecutionInput)
  │
  ├─ createExecution(input)
  │    ├─ 冻结参数 (snapshotJsonValue)
  │    ├─ 捕获 finalizeContent / projectContent 回调
  │    ├─ collapses() 检查 → PTC 模式下非 run_code 直接调用返回 UNKNOWN_TOOL
  │    └─ 返回 ScheduledToolPreparation
  │
  ├─ prepareExecution()
  │    ├─ callerCancelled? → ABORTED_BEFORE_DISPATCH
  │    ├─ tools/pre-execute 瀑布
  │    │    → allow / deny / cancel / ask 决策
  │    │    → approval 服务（serviceAsk）
  │    ├─ guardReason? → 单调拒绝
  │    ├─ callerCancelled? → ABORTED_BEFORE_DISPATCH
  │    └─ 返回 { kind: 'dispatch'|'post-result'|'final-result', exec }
  │
  ├─ dispatchScheduledExecution()
  │    ├─ tools/execute 瀑布（around-dispatch）
  │    │    → timeout-policy 注入 deadline
  │    │    → session-checkpoint flush
  │    ├─ dispatchToolBody() → tool.execute(args, exec)
  │    ├─ callerCancelled? → ABORTED
  │    └─ 返回 { kind: 'post-result'|'dispatch', result }
  │
  ├─ finalizeScheduledExecution()
  │    ├─ projectContent? → 执行预备内容投影
  │    ├─ tools/post-execute 瀑布
  │    │    → accept / block / replace 结果决策
  │    │    → spill-policy 溢出处理
  │    │    → repeat-tool-reminder 注入提醒
  │    └─ 返回最终 ToolExecutionResult
  │
  └─ finishScheduledExecution()
       ├─ applyFinalContent() → finalizeContent 回调
       ├─ materializeFinalResult() → deepFreeze 快照
       └─ emit('tools/result') → 最终结果通知
```

### 5.3 四个管线事件

| 事件 | 模式 | 用途 | 示例监听器 |
|------|------|------|-----------|
| tools/pre-execute | waterfall | 允许/拒绝/取消/审批 | hooks-claude-code, auto-review, workspace-changes, jobs |
| tools/execute | waterfall | around-dispatch（超时/重试/指标） | timeout-policy, session-checkpoint, browser-use |
| tools/post-execute | waterfall | 接受/替换/阻止结果 | spill-policy, repeat-tool-reminder, hooks-claude-code |
| tools/result | emit | 最终结果观察 | 无生产级监听器 |

### 5.4 关键管线监听器一览

**生产级**：

| 插件 | 钩子 | 功能 |
|------|------|------|
| timeout-policy | tools/execute | 为声明 timeoutMs 的工具注入 deadline，超时替换为 TOOL_TIMEOUT 结果 |
| repeat-tool-reminder | tools/post-execute | 检测连续重复调用，在 additionalContexts 注入提醒 |
| spill-policy | tools/post-execute + tools/ptc-dispatch-log | 过大输出溢出到文件，替换为预览+定位器 |
| workspace-changes | tools/pre-execute | 工具执行前等待 recorder settled |
| jobs/tool-jobs | tools/pre-execute | 记录可见输出上限 |
| session-checkpoint | tools/execute | 工具执行前 flush session |
| fs/tool-fs-search(glob) | tools/post-execute | glob 结果溢出 |
| fs/tool-fs-search(grep) | tools/post-execute | grep 结果溢出 |

---

## 六、PTC 模式层：run_code 与 SDK 生成

> 源码：`packages/core/tools/src/ptc.ts` + `ts-types.ts` + `py-types.ts`

### 6.1 PTC 模式核心思想

**PTC（Programmatic Tool Calling）**：模型**只能**调用 `run_code` 工具，所有其他工具通过 `run_code` 程序内部的 SDK 调用。

```
Native 模式：
  模型 → tool_call(name="bash", args={command:"ls"}) → ToolRuntime 直接执行

PTC 模式：
  模型 → tool_call(name="run_code", args={code:"await tools.bash({command:'ls'})"})
       → run_code 执行程序 → 程序内调 tools.bash() → ToolRuntime 子调度执行
```

### 6.2 collapses() — 模式折叠安全

```typescript
private collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean {
  return !nested && this.modeFor(scope) === 'ptc' && name !== RUN_CODE_NAME
}
```

- 模型直接调用（nested=false）非 run_code → 拒绝（返回 UNKNOWN_TOOL）
- 程序内部调用（nested=true）→ 放行
- 始终允许 run_code

### 6.3 createRunCodeTool()

```typescript
export function createRunCodeTool(
  registry: ToolRuntime,
  options: RunCodeBridgeOptions,
  ctx: Context
): ToolDefinition
```

- 使用 `defineTool()` 创建，name 固定为 `'run_code'`
- 参数：code(string, required) + description(string, required) + timeoutMs/sandbox_permissions/justification（条件注入）
- 输出：`{ logs: string[], result?: JsonValue, sandbox?: {mode, denied, enforcement?} }`
- **语言感知的 schema**：`description` 和 `code` 参数描述根据 PtcRuntime.language 动态切换（TypeScript/Python 各有 flavor）
- **执行体**：启动 PtcRuntime 运行程序，程序内通过 PtcCalls 桥接调用注册表中的其他工具

### 6.4 SDK 声明注入

PTC 模式下，`sdkSection()` 生成工具 SDK 声明注入系统提示词：

```typescript
private sdkSection(): PromptSection {
  return {
    name: 'tools:sdk',
    order: this.ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),  // 5000
    text: (context) => {
      const mode = this.modeFor(context.scope)
      if (mode === 'native') return ''
      const runtime = this.requirePtcRuntime(mode)
      const render = SDK_RENDERERS[runtime.language]
      return render(this.sdkSchemas(context.scope), runtime.programFormat)
    },
  }
}
```

**renderToolsSdk()**（TypeScript）将所有 visible 工具的 ToolSdkSchema 渲染为完整的 TS 类型声明：

```typescript
// 示例输出（简化）
type ToolArgsMap = {
  'bash': { command: string; description: string; timeoutMs?: number; ... }
  'web_search': { queries: string[]; maxResults?: number; ... }
  ...
}
interface ToolOutputMap = {
  'bash': { kind: 'foreground'; cwd: string; exitCode: number; ... } | ...
  'web_search': { content?: string; sources: {...}[]; ... }
  ...
}
declare const tools: {
  [K in keyof ToolArgsMap]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>
}
```

### 6.5 PTC 桥接机制

`PtcCalls` 类管理程序内的工具子调度：

1. 程序调用 `await tools.name(args)` → PtcRuntime 路由到 PtcCalls
2. PtcCalls 将调用提交到 ToolRuntime 的调度器（与 native 相同的并发规则）
3. 每个子调度触发 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch` 事件（log-only，不进入模型上下文）
4. 子调度结果返回给程序，**只有** run_code 的最终 curated 输出进入模型历史

---

## 七、MCP 外部工具注入

> 源码：`packages/mcp/mcp-client/src/index.ts`

### 7.1 MCP 桥接机制

`mcp-client` 插件连接外部 MCP 服务器，将其工具注册到 `ctx.tools`：

- 公共名格式：`mcp__<serverName>__<rawName>`（如 `mcp__wanfang-search__wanfang_search`）
- 每个 plugin 实例连接一个 MCP 服务器；多服务器需多实例
- 支持 stdio 和 streamable-http 两种传输

### 7.2 注册流程

```
MCP 服务器连接
  ├─ 列出服务器工具 (tools/list)
  ├─ 为每个工具创建 McpToolDefinition
  │     ├─ name: "mcp__<server>__<raw>"
  │     ├─ parameters: 从 MCP schema 转换
  │     ├─ output.render: MCP result → ContentBlock[]
  │     └─ execute: 通过 MCP 协议发送 tool/call
  ├─ ctx.tools.register(definition) → 注册到 ToolRuntime
  └─ 服务器指令注入 systemPrompt.section()
```

---

## 八、Agent Instructions 注入

> 源码：`packages/context/agent-instructions/src/index.ts`

### 8.1 AGENTS.md 加载与注入

`agent-instructions` 插件加载工作区中的 AGENTS.md 等指令文件，注入为 user message：

- **基线注入**：会话启动时加载 cwd 及其祖先目录的指令文件 → 追加为 user message（source.kind = 'agent-instructions'）
- **变更追踪**：监听 fs/observed 事件，文件变更时重新加载并投影新指令
- **SHA-256 增量**：用摘要比较决定是否需要更新上下文
- **作用域感知**：不同 agent 可能有不同的指令集

---

## 九、真实工具注册示例

### 9.1 bash 工具

| 属性 | 值 |
|------|------|
| inject | tools, shell, systemPrompt, shellEnv, workingDirectory |
| isConcurrencySafe | 未声明（false） |
| timeoutMs | 未声明（模型可传参透传） |
| presentCall | terminal(generic for background) |
| presentResult | terminal(generic for error) |
| systemPrompt | 静态 section（exit code 提醒） |
| 输出 | oneOf 三态：foreground / background / promoted |
| 动态注册 | 根据 JobRegistry 可用性切换前台/后台版 |

### 9.2 web_search / web_fetch

| 属性 | web_search | web_fetch |
|------|-----------|-----------|
| isConcurrencySafe | true | true |
| timeoutMs | 30000 | 30000 |
| presentCall | generic(search) | generic(fetch) |
| presentResult | web(search) | web(fetch) |
| systemPrompt | 动态（检查可见性+fetch共存） | 动态（检查可见性） |
| 特殊优化 | 多查询并发合并 | WeakMap 缓存 HTML→markdown |

### 9.3 skill 工具

| 属性 | 值 |
|------|------|
| inject | agents, tools, skills, workingDirectory |
| 注入路径 | **不走** systemPrompt.section()，走 agent/pre-step |
| 原因 | SHA-256 增量更新技能目录，避免每次重组装 |

### 9.4 FS 工具套件

| 工具 | isConcurrencySafe | 卡片类型 | 特殊 |
|------|-------------------|----------|------|
| read | true | read | 流式大文件读取 |
| write | false | diff | CAS 版本 waterfall |
| edit | false | diff | 精确文本替换 |
| read_image | true | generic | 条件注册（需 attachments） |

### 9.5 subagent 工具

| 属性 | 值 |
|------|------|
| isConcurrencySafe | true |
| systemPrompt | section() + context()（深度限制） |
| 动态注册 | Provider 生命周期 + Agent scoped fiber |
| 输出 | { kind: 'activation', subagentId } |

### 9.6 管线监听器汇总

**生产级**：

| 插件 | 钩子 | 功能 |
|------|------|------|
| timeout-policy | tools/execute | 声明 timeoutMs 的工具注入 deadline |
| repeat-tool-reminder | tools/post-execute | 连续重复调用提醒 |
| spill-policy | tools/post-execute | 过大输出溢出到文件 |
| workspace-changes | tools/pre-execute | 工具执行前等 recorder settled |
| jobs/tool-jobs | tools/pre-execute | 记录可见输出上限 |
| session-checkpoint | tools/execute | 工具执行前 flush session |
| fs/glob | tools/post-execute | glob 结果溢出 |
| fs/grep | tools/post-execute | grep 结果溢出 |

**实验级**：hooks-claude-code、hooks-codex、claude-code-mods、auto-review、browser-use-runtime、browser-use-stagehand-native

---

## 十、全链路数据流图

```
                        Cordis Plugin System
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         tool-bash        tool-web        mcp-client
              │               │               │
         defineTool()    defineTool()     McpToolDefinition
              │               │               │
         ctx.tools.register() ←────────────────
              │
    ┌─────────┴──────────┐
    │   ToolRuntime       │
    │   ScopedLayers      │
    │   ┌─ global layer   │
    │   │   tools: Map    │
    │   │   restrictions  │
    │   │   guards        │
    │   └─ scoped layers  │
    │       per-agent     │
    └─────────┬──────────┘
              │
    wireSchemas(scope)  ← 注册为 systemPrompt.tools provider
              │
    ┌─────────┴──────────┐
    │   SystemPrompt      │
    │   assemble()        │
    │   ├─ sections []    │  ← 每个 tool 的 systemPrompt.section()
    │   ├─ contexts []    │  ← 运行时上下文（工作目录等）
    │   ├─ tools []       │  ← wireSchemas 返回的 ToolSchema[]
    │   └─ variables {}   │  ← {{variable}} 插值
    └─────────┬──────────┘
              │
    PromptAssembly
              │
    ┌─────────┴──────────┐
    │   Agent Loop        │
    │   step()            │
    │   ├─ renderPrompt()  │ → developer message (系统提示词)
    │   ├─ runtimeContext  │ → user message (运行时快照)
    │   └─ buildRequest()  │
    │       ├─ messages    │
    │       └─ tools       │ → LLM API tools 参数
    └─────────┬──────────┘
              │
         ctx.llm.stream(request)
              │
         模型返回 ToolCallBlock[]
              │
    ┌─────────┴──────────┐
    │   executeToolCalls  │
    │   ├─ exclusive 组   │
    │   └─ parallel 组    │
    └─────────┬──────────┘
              │
    ┌─────────┴──────────┐
    │   ToolRuntime 管线  │
    │   createExecution   │ → collapses() 检查
    │   pre-execute       │ → allow/deny/cancel/ask
    │   guard             │ → 单调拒绝
    │   execute           │ → timeout/retry/body
    │   post-execute      │ → accept/replace/block
    │   finalize          │ → content 终态化
    │   result            │ → emit 通知
    └─────────────────────┘
```

---

## 关键设计模式总结

1. **双层 Schema**：作者侧 DSL（ValueSchemaSpec）→ 编译 → 强制子集 JSON Schema。作者侧更简洁，运行时侧更严格。

2. **ScopedLayers 作用域隔离**：全局层 + 每 agent 独有的 scoped 层，shadow 语义保证子 scope 可覆盖父 scope 的工具定义。

3. **自身注册豁免于 restriction**：子 agent 的自有工具不会被自身的 allow/deny 过滤掉。

4. **PTC 模式折叠**：collapses() 确保模型只能调用 run_code，子调度（nested=true）绕过折叠——一条谓词，两个执行路径。

5. **瀑布式管线**：pre-execute / execute / post-execute 三个 waterfall 点，每个插件可独立拦截/替换/增强，组合而非硬编码。

6. **guard 单调性**：只能拒绝不能放行，防止监听器顺序翻转决策。

7. **模型可见 = 可持久化**：工具 schema 和结果都经过 lossless JSON 校验，确保 session 日志可完整重建。

8. **presentation 软校验**：presentCall/presentResult 对旧 schema 容错降级，确保 session 回放不因 schema 演进而中断。

9. **事件路由向上继承**：scopeTarget 让祖先监听器观察到后代的事件，实现跨层策略执行。

10. **工具变更通知驱动重组装**：tools/change 事件触发 Agent Loop 下一步的 systemPrompt.assemble()，保证模型始终看到当前可见工具集。