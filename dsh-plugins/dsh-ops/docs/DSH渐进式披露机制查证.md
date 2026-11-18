# DeepSeek Harness 渐进式披露机制查证

> 本文档记录 DSH 工具层中渐进式披露相关机制的源码查证结果。

---

## 一、结论先行

DSH 工具层存在**两种**渐进式披露机制，但两者目的和层级完全不同：

| 机制 | 层级 | 目的 | 披露粒度 |
|------|------|------|----------|
| `deferLoading` | 工具声明级（基础设施） | 上下文缓存优化 | 工具是否可用（二元） |
| skill 目录注入 | 应用级（工具内容） | 认知负荷控制 | 工具内容的详细程度 |

**不存在**通用的"工具描述可折叠/可展开"机制——工具的 `description` 是静态的，没有"简略版/详细版"之分。

---

## 二、deferLoading — 工具声明级渐进式披露

### 2.1 问题背景

普通情况下，每次 LLM 请求都把**所有当前可见工具的完整声明**（name + description + parameters）放进 `tools` 参数。但有些模型（如 Anthropic Claude）支持**增量工具更新**——不需要每次重复声明所有工具，只需要告诉模型"新增了哪个工具"。

### 2.2 核心概念

`deferLoading` 是 `ToolSchema` 接口上的可选字段：

```typescript
// packages/llm/llm/src/types.ts:494-502
export interface ToolSchema {
  /** Requests deferred loading of the tool definition. */
  deferLoading?: true    // 唯一合法值就是 true
  name: string
  description: string
  parameters: Record<string, unknown>
}
```

在 `defineTool()` 侧：

```typescript
// packages/core/tools/src/schema.ts:499-500
/** Requests deferred loading of the tool definition; see {@link @deepseek-ai/dsh-llm#ToolSchema.deferLoading}. */
readonly deferLoading?: true
```

### 2.3 工作流程

#### 初始请求

1. 带 `deferLoading: true` 的工具声明出现在 `tools` 列表中
2. 但**不会被模型立即视为可用**——声明被"挂起"
3. `projectToolUpdates()` 在构建请求时保留 `deferLoading` 标记

#### 工具激活

1. 当新工具被注册时，`agent.ts` 的 `buildRequest()` 检测到工具列表变化
2. 生成 `tool-addition` developer message 块：

```typescript
// packages/core/agent-loop/src/agent.ts:655-666
const additions = tools.filter(tool => !previousNames.has(tool.name))
  .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
const removals = (baseline.tools ?? []).filter(tool => !currentNames.has(tool.name))
  .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
if (additions.length > 0 || removals.length > 0) {
  session.append('developer/message', {
    ...position,
    message: createDeveloperMessage({
      source: { kind: 'tool-registry' },
      content: [...additions, ...removals]
    }),
    ...additions.length > 0 ? { headerSeq } : {},
  }, { surfaceOp: 'append' })
}
```

3. 模型读到 `tool-addition` 块后才"激活"对应的 deferLoading 工具

#### 工具移除

对应地，工具被移除时发送 `tool-removal` 块（仅 `in-history` 模式支持）。

### 2.4 两种更新模式

```typescript
// packages/llm/llm/src/types.ts:413-425
/**
 * How a model accepts native tool declarations that change mid-conversation.
 * 'addition-only': the model reads a tool-addition block in a later
 * developer message as activating a tool declared with deferLoading, so an
 * added tool follows the cached history instead of rewriting the declaration
 * list.
 * 'in-history': the model additionally reads tool-removal blocks,
 * so a removed tool keeps its declaration and the removal follows the history.
 * Absent means every request declares the complete current tool list.
 */
export type ToolUpdate = 'in-history' | 'addition-only'
```

| 模式 | 含义 | 模型能看到的 |
|------|------|-------------|
| `addition-only` | 只支持新增 | `tool-addition` 块激活 deferLoading 工具 |
| `in-history` | 支持新增+移除 | 额外支持 `tool-removal` 块 |
| 不支持（默认） | 每次请求声明完整列表 | 所有工具立即可用，deferLoading 被剥离 |

### 2.5 projectToolUpdates() 核心逻辑

```
// packages/llm/llm/src/content.ts

projectToolUpdates(messages, tools, toolUpdate, history)
  │
  ├─ toolUpdate === undefined（不支持增量更新）
  │   → 剥离 deferLoading 标记，所有工具立即可用
  │   → 移除所有 developer message
  │
  ├─ history === undefined（无历史状态）
  │   → 保持当前 schemas 不变
  │
  ├─ messages 缺少某些 update 的 developer message
  │   → 无法解析历史声明，回退到当前 schemas
  │
  └─ 正常路径：
      ├─ toolDeclarations(tools, toolUpdate, history)
      │   → 后续 addition 中的工具自动标记 deferLoading: true
      │   → 生成声明 Map
      │
      ├─ offered = history.tools 中非 deferLoading 的工具名集合
      │   → 这些是"立即可用"的
      │
      ├─ 遍历 messages 中的 developer message：
      │   ├─ tool-addition 块：如果对应工具不在 offered 中 → 加入 offered，保留块
      │   │                如果已在 offered 中 → 丢弃块（重复激活无意义）
      │   └─ tool-removal 块：从 offered 中删除（仅 in-history 模式）
      │
      └─ 返回 { messages, tools: [...declarations.values()] }
```

### 2.6 Anthropic 适配器特殊处理

```typescript
// packages/llm/llm-pi-ai/src/adapter.ts:372-377
// pi-ai collapses Anthropic tool updates without an initially active declaration.
const needsPlaceholder = model.api === 'anthropic-messages'
  && updates.toolUpdate === 'in-history'
  && tools.every(tool => tool.deferLoading === true)
  && options.messages.some(message => message.role === 'developer'
    && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
const request = needsPlaceholder
  ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
  : options
```

当所有工具都是 `deferLoading` 时，Anthropic API 要求至少有一个初始工具声明，所以插入一个占位工具。

### 2.7 DeepSeek 适配器序列化

```typescript
// packages/llm/llm-deepseek/src/serialize.ts:163-168
tools: options.tools.map(tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
  ...tool.deferLoading === true ? { defer_loading: true as const } : {},
})),
```

DeepSeek API 原生支持 `defer_loading` 字段，直接透传。

### 2.8 Session 格式校验

```typescript
// packages/core/session/src/surface.ts:391-392
if (Object.hasOwn(definition, 'deferLoading') && definition.deferLoading !== true) {
  throw new Error('developer/message referenced tool deferLoading must be true when present')
}
```

Session 持久化时强制校验：`deferLoading` 如果存在，值必须是 `true`。

V3→V4 迁移中也明确检测：

```typescript
// packages/session/session-format-v3-to-v4/src/content.ts:76-78
if (isSessionFormatJsonObject(tool) && Object.hasOwn(tool, 'deferLoading')) {
  throw new SessionFormatUnsupportedMigrationError(
    `${subject}.header.tools[${index}] contains deferLoading, which is only defined in V4`,
}
```

### 2.9 实际使用情况

**目前没有生产级工具显式声明 `deferLoading: true`。** 搜索整个 `packages/` 目录，`deferLoading` 只出现在：

- 定义和传递代码（schema.ts、index.ts、types.ts、content.ts）
- 适配器序列化代码（serialize.ts、adapter.ts）
- Session 格式校验代码（surface.ts、v3-to-v4）
- 测试 fixture（dynamic-tool-updates.ts）

这个机制是为**动态工具注册场景**预留的基础设施——当工具在会话中途被动态添加/移除时，配合支持增量更新的模型 API，可以避免重写完整工具声明列表，从而保护 prompt cache。

---

## 三、skill 目录注入 — 应用级渐进式披露

### 3.1 问题背景

skill 工具的完整指令可能长达数千字（如 `caveman`、`budget-discipline` 等）。如果一开始就把所有 skill 的完整内容注入系统提示词，会严重占用上下文窗口。DSH 采用"先给摘要，按需加载全文"的策略。

### 3.2 注入路径

skill 工具**不走 `ctx.systemPrompt.section()`**，而是走 `agent/pre-step` 监听器：

```typescript
// packages/skill/tool-skill/src/index.ts
ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
  const decision = await next()
  // ...
  const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
  const snapshot = toolVisible
    ? await ctx.skills.snapshot({ cwd: ..., signal, scope: agent })
    : { skills: [], complete: true }
  // ...
})
```

**不走 section() 的原因**：skill 目录用 SHA-256 摘要做增量比较，而 `systemPrompt.section()` 的 text 函数每次 assemble 都会执行。用 `agent/pre-step` 可以在 step 粒度控制更新频率。

### 3.3 两步披露流程

#### 第一步：注入技能目录（摘要）

```typescript
function renderCatalogMessage(entries): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions.',
        'The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),  // 每个 skill 只有 name + 一句话摘要
        '</available_skills>',
        '',
        "This catalog contains summaries only; do not infer or follow",
        "a skill's instructions until it has been loaded.",
        "If the user names a skill, or the task clearly matches a skill's",
        "description, call the `skill` tool with the exact skill name.",
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries },
  })
}
```

目录示例：

```
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `caveman`: 超压缩通信模式。通过删除填充词、冠词和客套话...（约 500 字符截断）
- `budget-discipline`: 预算与止损：任务前定 token/时间上限...（约 500 字符截断）
- `diagnose`: 针对严重错误和性能回归的严格诊断循环...（约 500 字符截断）
</available_skills>

This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
</system-reminder>
```

#### 第二步：按需加载完整指令

模型调用 `skill` 工具：

```
model → tool_call(name="skill", args={name:"cavemen"})
     → 返回完整的 SKILL.md 内容（可能几千字）
```

skill 工具定义：

```typescript
// packages/skill/tool-skill/src/index.ts:84
defineTool({
  name: 'skill',
  description: 'Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.',
  parameters: { name: { type: 'string', required: true } },
  output: {
    schema: { name, provider, resourceBase: oneOf[directory|url|opaque], content },
    render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
  },
})
```

### 3.4 SHA-256 增量更新

```typescript
// packages/skill/tool-skill/src/index.ts
const digest = digestCatalogEntries(entries)
const history = catalogHistory(agent)
const existing = catalogMessage(decision.messages)

// 摘要未变 → 不更新
if (history.visibleDigest === digest) {
  return existing === undefined ? decision : /* 移除旧消息 */
}

// 摘要变了但内容等价 → 不更新
if (existing !== undefined && digestCatalogEntries(existing.entries) === digest) return decision

// 首次无 skill 且未发布过 → 不注入
if (!history.published && skills.length === 0) return decision

// 真正变化 → 更新目录
const catalog = history.published
  ? renderCatalogUpdate(entries)    // 增量更新
  : renderCatalogMessage(entries)   // 首次完整目录
```

关键点：
- **首次**用 `renderCatalogMessage()` 注入完整目录
- **后续**用 `renderCatalogUpdate()` 只注入变化部分
- **摘要比较**用 SHA-256 digest，避免字符串比较的假阳性

### 3.5 摘要长度控制

```typescript
// packages/skill/tool-skill/src/index.ts:61
interface Config {
  /** Maximum length of each skill's catalog description (default 500). */
  catalogDescriptionMaxLength?: number
}
```

每个 skill 在目录中的描述被截断到 `catalogDescriptionMaxLength` 字符（默认 500）。

### 3.6 用户手势触发

除了模型主动调用 `skill` 工具，还有一条用户手势路径：

```
用户消息中的 "/skill-name" 模式
  → agent/pre-step 匹配
  → 自动调用 skill 工具加载完整指令
  → 注入为 user message（source.kind = 'skill-content'）
```

### 3.7 与 deferLoading 的本质区别

| | deferLoading | skill 目录 |
|---|---|---|
| **披露什么** | 工具是否可用（二元开关） | 工具内容的详细程度 |
| **驱动方** | 基础设施（ToolRuntime + LLM adapter） | 应用逻辑（skill 插件） |
| **谁受益** | prompt cache 命中率 | 模型的注意力分配 |
| **粒度** | 整个工具 | 工具内部的指令内容 |
| **触发条件** | 工具动态注册/注销 | 模型主动调用 skill 工具 |
| **模型感知** | 通过 developer message 中的 tool-addition/removal 块 | 通过 available_skills 目录 + skill 工具返回值 |

---

## 四、相关代码索引

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/core/tools/src/schema.ts` | 499-500 | `deferLoading` 字段定义 |
| `packages/core/tools/src/schema.ts` | 595 | defineTool 传递 deferLoading |
| `packages/core/tools/src/index.ts` | 1291-1300 | wireSchemas 传递 deferLoading |
| `packages/llm/llm/src/types.ts` | 413-425 | ToolUpdate 类型定义 |
| `packages/llm/llm/src/types.ts` | 494-502 | ToolSchema.deferLoading 定义 |
| `packages/llm/llm/src/types.ts` | 115-130 | ToolAdditionBlock / ToolRemovalBlock |
| `packages/llm/llm/src/content.ts` | 385-500 | projectToolUpdates 完整实现 |
| `packages/core/agent-loop/src/agent.ts` | 655-666 | tool-addition/removal 生成 |
| `packages/llm/llm-pi-ai/src/adapter.ts` | 372-377 | Anthropic 占位工具处理 |
| `packages/llm/llm-deepseek/src/serialize.ts` | 163-168 | DeepSeek defer_loading 透传 |
| `packages/core/session/src/surface.ts` | 391-392 | Session 格式校验 |
| `packages/session/session-format-v3-to-v4/src/content.ts` | 76-78 | V3→V4 迁移检查 |
| `packages/skill/tool-skill/src/index.ts` | 84-100 | skill 工具定义 |
| `packages/skill/tool-skill/src/index.ts` | 209-274 | agent/pre-step 目录注入 |
| `packages/skill/tool-skill/src/index.ts` | 276-295 | renderCatalogMessage 实现 |

---

## 五、未发现的相关机制

以下"渐进式披露"相关模式在 DSH 工具层中**不存在**：

1. **工具描述可折叠/可展开**：`description` 是静态字符串，没有"简略版/详细版"切换
2. **工具参数渐进式披露**：`parameters` 一次性完整暴露，没有"先看必填、后看可选"
3. **工具结果渐进式披露**：结果要么完整返回，要么被 spill-policy 溢出到文件（不是"先给摘要再给全文"）
4. **工具按上下文窗口大小自适应裁剪**：没有根据剩余 token 数动态缩减 description/parameters 的逻辑
5. **工具分类/分组渐进披露**：没有"先看一类工具、后看另一类"的分组机制