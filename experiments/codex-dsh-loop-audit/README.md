# Codex → DSH 主 Agent 执行机制审计（2026-11-10）

当前结论：保留 DSH AgentLoop，先修复工具契约、提示词组合和协作等待边界。尚无证据证明重写 core 或复制 Codex 提示词能提高 GLM 的推理、文学质量。已交付一项免费验证的可靠性改进：指定工具的参数 Schema 在模型请求前预检。

## 来源与证据范围

按作者要求从 `https://github.com/openai/codex.git` 下载完整工作树的浅克隆，固定 `6dfaca4dad030f5ecaf4925f210f539353b15594`（2026-11-10 main HEAD）。这是审计取样，不称其为稳定发布版；没有安装、编译或运行 Codex，也没有修改原 LiteraryAgent 的固定 Core。DSH 是现有 0.2.2-rc.1，固定供应源码基线 `fcc0ad4` 并包含此前 LG 改动；[sources.json](sources.json) 记录本次读到的关键文件摘要，避免把修改后的本地树误认为纯上游。

Codex 副本在本机 LitIsLand 的 `audits/codex-loop-20261110/`，独立实验在 `audits/codex-dsh-policy-20261110/`。没有把其整仓复制到产品。阅读实现和上游测试只能支持机制结论，不能算已执行上游测试；本轮执行项见 [verification.json](verification.json)。

## 两条真实调用路径

### Codex

`session/turn.rs::run_turn` 接收任务，检查输入／上下文压力和待处理事件，构建本步 `StepContext` 和工具路由，记录变化的运行状态，从保留历史生成请求输入。

`run_sampling_request` 建立 `ToolCallRuntime`，取得 base instructions，按模型能力决定工具增量形式；`build_prompt` 合并历史、可见工具、并行声明和输出约束。`try_run_sampling_request` 调用 `ModelClientSession::stream`；`client.rs` 负责供应商请求封装。模型调用发生在这里，不是每次规划或工具调用都另起一次模型。

流中完整输出项交给 `handle_output_item_done`；工具 future 加入 `FuturesOrdered`。`tools/parallel.rs` 依据工具是否支持并行取得读／写锁，完成授权、调度和取消处理。末尾排空已启动工作，结果进入历史。`needs_follow_up = model_needs_follow_up || has_pending_input` 决定是否再请求；停止前执行 Stop hooks，必要时接受有来源的继续输入。上下文压缩和 mailbox 都可能改变下一步。

固定源码：[run_turn](https://github.com/openai/codex/blob/6dfaca4dad030f5ecaf4925f210f539353b15594/codex-rs/core/src/session/turn.rs#L217)、[build_prompt](https://github.com/openai/codex/blob/6dfaca4dad030f5ecaf4925f210f539353b15594/codex-rs/core/src/session/turn.rs#L1842)、[模型请求](https://github.com/openai/codex/blob/6dfaca4dad030f5ecaf4925f210f539353b15594/codex-rs/core/src/session/turn.rs#L2890)、[工具并行调度](https://github.com/openai/codex/blob/6dfaca4dad030f5ecaf4925f210f539353b15594/codex-rs/core/src/tools/parallel.rs#L161)。

### DSH

`agent.ts::turn → preStep` 领取 inbox，快照模型选择，`tools.resolve` 固定本步准入工具；`systemPrompt.assemble` 汇总提示段、动态上下文和工具声明，再执行 `agent/pre-step`。

`step → prepareRequest` 绑定适配器、解析控制参数；将 system／用户／运行状态记录到 Session，`buildRequest` 从日志冻结模型输入。调用 `preparedCall.stream(request)` 或 `llm.stream(request)`；经过 `llm/stream` waterfall 进入适配器。

完整 assistant 流提交后，`tools.execute → executeToolBatch` 执行工具：可并行调用使用有限并发池，独占工具构成屏障，策略和结果按模型顺序落日志，取消会等待已启动工作收束。普通工具结果要求下一步；`concludesTurn`、无工具输出、max-tokens、错误等决定结束。`agent/turn-stopping` 允许插件在停止边界提供下一步输入；inbox 可唤醒后续轮次。

本地依据：`dsh/packages/core/agent-loop/src/agent.ts:284,327,436,590,616`；`core/tools/src/batch.ts:47`；`core/system-prompt/src/index.ts:620`。原有实现已具备可靠循环、作用域、日志与恢复；无需为文学 Agent 另写一套。

## 思考链、提示词与最终合并

模型内部推理不能从上述代码还原。两套宿主都能选择 reasoning effort、保留供应商公开的 reasoning／replay 信息、执行显式计划和工具反馈，但这些不等于读取模型全部内部思维。未发现可作为通用默认策略的“先输出完整思维链再行动”。Codex 的效果还依赖模型、工具训练、上下文、能力开关和产品策略，不能全部归因于 Rust 循环。

Codex 的 `prompts/src/model_instructions.rs::render_model_instructions` 从捕获的 `ModelInfo` 取模板；`session/mod.rs:912` 优先配置／已有历史，否则使用该模板。运行时配置与工具按条件装入后续上下文；不是一份永远固定、适配所有供应商的万能 system prompt。多 Agent 汇总同样需要主 Agent 的模型请求处理返回信息，代码不保证自动得到高质量综合结论。

DSH 有部署 persona、工具指导、任务策略、运行上下文等贡献。`systemPrompt.assemble` 按 order／name 排序、插值，工具声明由 provider 持有；`RuntimeContextProjection` 对未变化内容去重，`SystemPromptProjection` 按适配器能力选择替换或追加。OPS 提供渐进工具发现、结果分页、重复阅读处理和提示注入接口，本身不是另一个推理引擎。

当前文学实验插件以 `complete: true` 替换整份 system prompt。真实组装器实验证明：其他 system 段被压掉，但工具 Schema 和 required runtime context 保留。因此“装了 OPS”不保证它的 system 指导被模型看到；这只是当前实验组合问题，不能推断所有桌面配置均有此故障。

建议随后将文学身份放入部署 persona／角色作用域，把任务信息放入带来源的动态上下文，保留已授予工具所需的指导。先对最终实际请求做贡献清单与冲突审查，再做效果对照；不能直接取消 complete 后把所有 coding 指导重新混入。此次没有改变文学插件的提示词。

## 逐项比较与改进判断

| 机制 | Codex 源码证据 | DSH 现有机制／具体缺口 | 下一步与归属 |
| --- | --- | --- | --- |
| 模型请求与推理配置 | `turn.rs::run_sampling_request`；`session/reasoning_effort.rs`；按 ModelInfo 取提示模板 | `prepareCall`、模型目录、`configureCall` 已有；本轮文学实验 reasoning=off，未对照 | 保持同模型与任务，单独比较 effort／persona，放配置和策略插件；先不动 core |
| 提示词合并 | `session/mod.rs::assemble_initial_context`；`prompts::render_model_instructions` | 贡献排序、作用域、complete 已有；当前 complete 压掉其他 system 指导 | 对最终请求建立贡献清单；角色 persona 与工具指导分开，做插件组合实验 |
| 工具契约 | `multi_agents_spec.rs` 用 `JsonSchema::object` 显式构造属性和 required；工具 handler 再解析参数 | `defineTool` 已有；raw register 只验证 output，上一轮混用了两种输入格式 | 本次 opt-in 预检已实现；后续新工具优先 defineTool。不是复制 Codex strict 模式：所读协作工具多为 strict=false |
| 工具并发／流式启动 | `turn.rs` 在 OutputItemDone 派发；`parallel.rs` 读写锁；`router.rs::tool_supports_parallel` | 有限并发池、独占屏障、顺序提交已有；当前先收完 assistant 再执行整批 | 默认保留。流式提前执行只可能减少等待，不证明文学质量；需要宿主流事件与取消／授权／SDK 一致性改造，不能用插件偷跑 |
| 等待与继续 | `multi_agents_v2/wait.rs` 等待 mailbox／用户输入／超时；`run_turn` 显式 needs_follow_up | inbox、whenIdle、waitForTreeWork、concludesTurn 已有；实验团队曾忙轮询 | 用状态改变唤醒和有界等待。主 Agent 协调属于协作插件，不另加一轮路由模型；重分派清退仍有上轮未解决宿主缺口 |
| 上下文与压缩 | `record_context_updates_and_set_reference_context_item` 先全量、后 diff；`context_manager/history.rs` 保持工具调用／结果可配对 | 运行快照去重、请求 series、压缩／工具配对已有 | 复用现有基础；文学版本／范围／证据放领域 context 插件。压缩后必须保留作者要求、候选状态和可重新读取的来源 |
| 工具结果与汇总 | `tools/context.rs` 区分收集输出与模型截断；history 中截断不抹完整 rollout | OPS 分页／spill 等已有；团队 status 曾截短报告，已加完整读报告工具 | 主 Agent 获取任务号、来源版本、完成状态、完整报告引用和冲突项；通过独立汇总请求评价，不强塞所有子 Agent 会话 |
| 停止与审查 | `run_turn` 先检查 follow-up 再运行 Stop hooks，hooks 可要求继续 | `agent/turn-stopping`、goal／workflow 等扩展已有 | 有明确验收失败才继续且限次；不让模型自评无限重写。主子 Agent 共用边界，不强制每题规划／复核 |

Codex 中的 world_state 指运行环境／工具／权限等上下文，不是 LG 的故事世界、人物认知或正式事实；二者不能共用一个业务状态定义。Codex 有工具注册、调度、失败和历史测试，但本轮未运行其测试，不能据此宣称迁移后获得相同可靠性。

## 本次实际交付

新增 [lg-agent-preflight](../../dsh-plugins/lg-agent-preflight/README.md)，只复用 DSH 的 `assertObjectJsonSchema`，在公开 `llm/stream` 钩子检查显式选定工具。错误给出 `TOOL_PARAMETER_SCHEMA_INVALID`；合法请求不改写、不增加消息、不调用其他模型。对同作用域的主／子 Agent 都生效，未全局安装。

它借鉴明确契约和能力边界的工程原则，没有复制 Codex Rust 实现，也不等于推理增强。明确限制：外部 MCP Schema 可能超出 DSH 校验子集；未配置工具、未出现在请求中的 PTC 内部工具不检查；模型生成的参数仍由工具验证；配置名称存在性和正式预算钩子的组合尚未验收。

免费证据：

- 隔离和实际项目各 7 项测试通过，0 跳过。无插件时旧 shorthand 会到达假适配器；有插件时到达次数为 0。合法请求保持对象与流片段身份；重新使用已改变的声明会重新检查；卸载撤销拦截。
- 真实 DSH AgentLoop 记录明确失败码且保留一次用户输入；合法声明一轮完成。
- 真实组装器确认 complete 的 system 覆盖行为和动态上下文／Schema 的保留。
- 项目真实 CLI 加载新插件和原单成员团队，14 次脚本响应完成主成员回报，正式正文写入 0。脚本响应包含故意非法调用，不能拿 14 次当真实模型效率指标。
- 新增真实模型请求 0；原 19/20 已关闭账本不续用。未运行 Codex、未修改 DSH core、未构建桌面包、未执行全量 lint／回归。

首次宿主测试使用了不存在的私有 agent.done，2 项失败；改成公开 agent/status 空闲事件后通过。没有为使测试通过修改 Runtime。

```sh
.dsh-dev/node/bin/node --test dsh-plugins/lg-agent-preflight/tests/preflight.test.mjs dsh-plugins/lg-agent-preflight/tests/host.test.mjs
python3 experiments/codex-dsh-loop-audit/verify-project.py --lab /absolute/prepared/literary-team-v2
```

CLI 复跑依赖上轮已准备的审计副本、编译产物及快照，不是独立安装器；强制模拟模型、隔离 HOME，不读真实凭据。私有日志和正文不进入 Git。停用独立实验 profile 即退出实验；插件卸载撤销其钩子。未改默认 profile，未删文件或旧实现，未提交／推送。

## 下一轮只做一项可归因的比较

优先做“文学 persona + 必需工具指导”的提示词组合，对照当前 complete 配置。复用同一章、同模型、相同上下文、工具和生成设置；先用免费真实组装测试确定两个实际输入只差该策略，再申请新的有限模型额度。

预先固定三类任务：直接回答不委派；委派一名分析员后等待回报；工具失败后准确解释原因。测作者目标满足、来源正确性、无进展／重复调用、首个有效动作耗时、输入／输出 token、请求数，以及人工修改量。不能只看 token 下降；不能把消除错误 Schema 的收益归因于提示词。文学判断由作者盲看候选，并保留不满意和无法区分选项。

该项通过后，再做结构化委派／结果合并；随后做长上下文压缩恢复。每次只改变一个机制，允许撤回无收益策略。今后可把通过验证的组件组合成一个 `lg-agent-policy` 插件包，在内部划分 prompt、tool-contract、coordination、context 等职责；现在不创建大而全 Orchestrator。团队插件消费其稳定能力，故事 Kernel 继续拥有作品和作者批准规则。
