# LiteraryGiant — Codex 接手规则

## 先读

1. `README.md`。
2. `docs/handoff.md`、`docs/conversation-context.md` 和 `docs/local-development.md`。
3. 修改 `LiteraryAgent/` 前读其 `AGENTS.md`、`docs/architecture.md` 和 `docs/roadmap.md`；修改 vendored Core 时继续遵守更深目录规则。

## 工作约定

- 默认中文交流，说明简洁、命令可复制。编辑前识别文件并用 3–6 点说明计划；执行命令前说明确切命令及原因。
- 优先小而可审查的变更，不顺带重构；路径/API 不确定先用 `rg`/`rg --files` 查找。
- 独立 Shell 操作分别执行，不无故用 `&&`、`;` 或管道拼接。确有必要时先解释。
- 删除任何文件前获得作者对具体删除范围的授权；不把清理、部署或同步当成自动删除授权。
- 密钥、令牌、凭据、`.env` 内容不得进入代码、日志、Git 或交接资料；凭据在各机器单独配置。无请求不增加遥测或网络行为。
- 先在 LitIsLand 隔离副本实验、测试和处理依赖；选出最小可用变更后再应用到项目，并运行实际项目入口。Mac 可使用同名 Conda 环境；服务器固定环境为 `/opt/conda/envs/LitIsLand`。
- 项目有测试时，行为改变需补相应回归。可能影响构建时先跑最快相关检查，避免重复全量验证。
- 代码变更交付说明变更摘要、文件和验证；故障排查说明假设、实验和最小修复。

## 仓库与数据边界

- 本机开发，服务器运行。代码通过 Git 传递；服务器的 Library、模型、作品状态、密钥和机器配置不被代码部署覆盖。
- `LiteraryAgent` 是独立仓库；先在子仓库提交/推送，再在父仓库更新其提交引用。递归更新默认使用父仓库固定的提交，不用 `--remote` 静默漂移。
- `Library` 是知识数据，`Projects` 是用户作品，`.literarygiant` 是运行/故事状态。不得为代码任务移动、重写或删除这些数据，不得批量扫描原始语料。
- `.vscode/settings.json` 是本机配置，复制示例后按当前机器填写绝对路径。不得把服务器二进制、绝对路径或凭据当成 Mac 通用环境。
- `core/codex` 为固定上游基线，不加 LG 产品逻辑；产品 API-only，保留 Rust TUI 与独立 app_server 的已批准边界。
- 模型生成内容是候选。采用正文、选择正式情节和提升 Canonical 事实受来源、版本、任务范围和作者批准约束。

## 接续上下文

GitHub 上的是脱敏上下文；私有迁移包与可访问的历史对话另存。`docs/conversation-context.md` 是人工整理的决策记录，不是完整会话，不代表继承了旧进程、工具授权或未导出的聊天。

Codex 会读取目录层级中的 AGENTS.md；参考 [官方规则](https://developers.openai.com/codex/guides/agents-md/)。新会话先报告分支、提交、子模块和工作树状态，再按作者新任务继续，不自行启动路线图中的待办。
