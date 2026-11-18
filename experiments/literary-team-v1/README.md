# 单成员文学协作实验 · 2026-11-10

本轮交付的是独立实验插件和可复核的机制证据，尚未完成真实团队的文学效果验收。桌面默认 profile 没有启用它；旧 lg-agents / lg-director 没有改写或删除。

## 范围与固定输入

DSH 主 Agent 保留自己的执行循环，按需创建固定 AgentTeams 预设，委派一名只读分析成员。实验使用《放开那个女巫》前 100 章实验书的第一章快照，仅第一章可读。成员输出观察、推测、未知及段落引文；候选不进入正式正文或 Canonical。

上游来源与版本见 [upstream.json](upstream.json)。AgentTeams 固定在 `369c2785c473e546124ab1709664058e6ea93948`，本地适配见 [AgentTeams 补丁](patches/agent-teams-compat.patch)。DSH 0.2.2-rc.1 的 [宿主投递补丁](patches/dsh-host-delivery.patch) 已应用到当前项目源码，未更改模型—工具循环。

插件源码与职责见 [lg-literary-team](../../dsh-plugins/lg-literary-team/README.md)。外部 AgentTeams 仍保留在 LitIsLand 审计副本中，没有整体导入产品。

## 实验结论

| 检查 | 结果 | 能说明什么 |
| --- | --- | --- |
| 宿主投递回归 | 隔离、实际项目各 19 项通过 | 排队、冷恢复、来源保留、跨树拒绝与取消检查有效 |
| AgentTeams 兼容性定向单元 | 19 项通过 | 已适配当前启动参数、模型选择与投递接口；不等于全插件兼容 |
| 文学证据、JSON Schema、预算 | 实际项目 5 项通过 | 拒绝旧版本、伪造引文、越界段落和未授权能力；20 次上限、结算关闭有效 |
| DSH 免费整链 | 隔离及项目实际 CLI 通过 | 创建团队、成员读取、提交、回报、主 Agent 自动唤醒及读取完整报告可贯通 |
| 免费恶意工具调用 | 拒绝 shell、第二章读取、伪造引文 | 限制由实际工具执行器执行，不只写在提示词中 |
| 首次真实团队 | **失败，17 次请求** | 新增读章工具的错误参数 Schema 使模型传入空对象；错误被误报为权限不足，主 Agent 又反复查询结果 |
| 修复后的真实读章定点验证 | **通过，2 次请求** | 模型正确传入 chapter=1，获得正文并引用真实段落；只证明该接口修复 |
| 修复后的完整真实团队 | **未验证** | 剩余预算不足以重新跑完整闭环，不能以模拟结果替代 |
| 完整 AgentTeams 稳定性 | **未通过** | 当前 DSH 缺少定向成员清退接口；重分派可遗留 stopping 状态，归档和嵌套工作未验收 |

修复包括：标准 JSON Schema；委派成功即结束主 Agent 当前轮次；读取尚未完成的分析返回 pending 并结束轮次；主 Agent 使用 `lg_read_analysis` 读取完整候选，避免状态工具截短报告。当前执行 guard 不开放重分派、归档、成员增删或嵌套委派。

真实模型两次运行均固定 GLM-4.5-Air、reasoning off、maxTokens=4096、自动重试为 0；标题生成关闭。总计 **19/20 次请求**，19 条请求均有结束记录，账本已关闭，剩余一次不自动沿用。记录用量 inputTokens=12444、outputTokens=2073；不据此假定实际现金扣费。首轮模型关于“版权保护导致不能读取”的解释没有依据，实际原因是本次实现的参数声明错误。

所有引文检查只证明字符串确实位于指定段落，不能证明解释成立、文学效果更好或模型没有使用记忆中的后文。真实读章回答中的“已经穿越到另一个世界”也应作为叙事解释另行判断，不能自动升级为正式事实。

## 证据与复跑

本机私有证据保留在 `~/.local/share/python-envs/LitIsLand/audits/literary-team-v2/`：`host-results-2` 记录主 Agent 唤醒通过及其他稳定性失败；`runs/offline-3` 是修复后隔离重放；`runs/live-1` 是保留的真实失败；`runs/live-read-check` 是真实读章复验；`paid-ledger` 是已关闭账本。`project-smoke-iba8s1n6` 是实际项目 CLI 重放。正文快照、请求全文、用户数据和凭据不进入 Git。

以下命令在仓库根目录运行过；最后一条只使用模拟模型，不读取真实凭据，也不会开启付费请求：

```sh
.dsh-dev/node/bin/node --test dsh-plugins/lg-literary-team/tests/analysis.test.mjs dsh-plugins/lg-literary-team/tests/schema.test.mjs experiments/literary-team-v1/budget.test.mjs
python3 experiments/literary-team-v1/verify-project.py --lab "$HOME/.local/share/python-envs/LitIsLand/audits/literary-team-v2"
```

`verify-project.py` 需要已经准备好的 LitIsLand 副本及编译产物，不是独立安装器。它使用当前项目 CLI、当前宿主包和当前文学插件，给外部 AgentTeams 建立同一宿主依赖图，避免混用两份 Cordis。探针在模型调用前检查文学工具的 JSON Schema；免费模型脚本会故意发出非法调用来验证拒绝路径。

实际项目已执行 subagent 定向 `tsc -b`、`tsdown --filter @deepseek-ai/dsh-subagent` 和 `build:check`，Host / Client 两项检查通过。没有重新构建桌面安装包，也没有完成全部 DSH 文档、lint 或全量回归。

## 回退与下一步

实验没有安装到桌面 profile；停止使用独立实验 profile 即可停止该插件。宿主新增方法为添加式变更，回退可审查并反向应用对应补丁，只触及本批文件，不重置整个工作树；不删除实验结果或作品。

下一小步应继续同一个案例：缩短领取任务、状态更新、完成回报等协调开销，验证成员确实读到原文、给出可用判断、主 Agent 能准确汇总。修复版完整真实团队需新的明确调用额度；先完成它，再决定是否加入规划／创作成员。人物侧写和 Dashboard 延后。
