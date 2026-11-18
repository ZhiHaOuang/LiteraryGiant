# LG Agent 工具契约预检（实验）

在请求模型前检查指定工具的参数 JSON Schema，防止声明错误反复消耗模型调用。当前仅固定 DSH 0.2.2-rc.1；默认不安装、不启用。

```yaml
- name: /absolute/lg-agent-preflight/index.js
  config:
    toolNames: [lg_read_chapter, lg_read_analysis]
```

通过公开 `llm/stream` waterfall 调用 DSH 自带 `assertObjectJsonSchema`。仅检查配置名称在本次请求中出现的声明；主 Agent、子 Agent 和辅助请求在同一插件作用域内遵循同一规则。工具未出现在请求时允许通过，因此不能用它验证工具一定已安装。

错误以 `TOOL_PARAMETER_SCHEMA_INVALID` 停止请求，要求修正工具注册。合法请求和流片段原样传递；不修改提示词、工具参数、权限或模型设置，不保存请求内容。每次重新检查，避免缓存掩盖声明变更。卸载插件撤销钩子。

只接受 DSH 自带校验器支持的 Schema 子集；不要未经核验就将外部 MCP 工具加入列表。PTC 内部能力未逐个出现在请求时，不在本插件覆盖范围。它不校验模型生成的实际参数；工具仍须使用 `defineTool` 或自己的执行时验证。未配置的工具原样通过。

若存在预算钩子，应让预检处在其外层，避免无效请求先预留费用；当前免费 CLI 实验未验证与正式预算插件的组合。没有自动修正、自动重试或附加模型调用。

从仓库根目录运行：

```sh
.dsh-dev/node/bin/node --test dsh-plugins/lg-agent-preflight/tests/preflight.test.mjs dsh-plugins/lg-agent-preflight/tests/host.test.mjs
```

实验依据、源码对照及局限见 [审计记录](../../experiments/codex-dsh-loop-audit/README.md)。这是借鉴契约明确化原则、复用 DSH 机制的独立实现，没有复制 Codex 的 Rust 代码或提示词。
