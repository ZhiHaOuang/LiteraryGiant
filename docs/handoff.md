# 开发交接 — 2026-10-18

## 接手目标

作者设备为 Mac Studio、M3 Ultra、96GB 内存，本地使用 Codex 开发；当前 Linux 服务器继续承载运行、Library 与模型。沿用两个公开仓库：`ZhiHaOuang/LiteraryGiant` 的 `main` 与 `ZhiHaOuang/LiteraryAgent` 的 `literary-agent`。父仓库提交固定产品子仓库版本。

作者明确选择：代码与脱敏交接文档上传 GitHub；作品、数据库和原始对话另做私有迁移包。基础依赖与服务器 GPU 依赖分开；不借交接进行产品重构、Core 升级或作品整理。

## 当前已知进度

产品版本号仍为 0.3.0。交接前父仓库 HEAD 为 `39a2e9ccd800404f0c43b6c6f608ee6c2a7ffcb3`，产品子仓库 HEAD 为 `3a8b6d8d8d12f5dda5e9662521f37970f8b0a262`；两者都不足以代表当时完整工作状态。子仓库有大量后续实现和测试未提交，本次一并保留。最终基线以 GitHub 上父仓库固定的子模块提交及私有包清单为准。

已实现内容：主 CLI/Extension 使用共享 Literary Backend；Codex/Native 适配；API-only；作者审批与候选/采纳分离；来源、版本、并发和正式方向裁决；会话/阶段恢复；工作流输入输出契约与若干领域上下文投影。Rust TUI 与独立 app_server 已由作者决定保留为兼容入口。

历史路线图记录了 2026-10-16 的 Python 982 项、Extension 单元 55 项/集成 14 项验收。这是历史记录；本次实际执行、跳过与限制单列于 `validation-20261018.json`。工程夹具验证不证明真实长篇文学质量。

本次新环境验收复现了两处同类测试等待问题：创作方向和叙事知识审批测试只等约 1 秒，真实 Native MCP 子进程启动时可能尚未就绪。最小修复仅把两处测试辅助方法改为单调时钟、最长 10 秒等待，保留审批种类、拒绝/接受、撤回与状态不变等原有断言；产品实现没有因这一修复改变。失败记录与修复后回归分别保留。

下一阶段按 `LiteraryAgent/docs/roadmap.md` 的完成边界推进：

1. 文学任务执行模型（R5）：局部润色轻量执行，复杂章节任务具有有界编排与作者可见决定。
2. 完整模型输入的信息可见性约束：世界事实、角色认知、读者知识、作者计划及故事时间/阅读顺序分别处理。
3. 来源变更后的依赖影响传播和重新复核；保留已有作者确认语义。
4. Runtime 的通用委派、预算与覆盖对齐，以及可拆批的产品依赖裁剪；不得默认删除 TUI、搜索、编辑、Shell 或调度机制。
5. 同模型盲评与连续长篇创作实验。真实收益尚待证明。

## 目录与私有状态

GitHub 保存代码、测试、配置模板、脱敏说明和原有占位文件。`Library` 大数据、`models` 权重、`runs`/日志、作品正文、数据库、凭据与会话原文不进入公开提交。

服务器仓库位置为 `/root/private_data/LiteraryGiant`。`Projects` 下已有作品，另有 `LiteraryAgent/Projects` 与根目录/子仓库的 `.literarygiant` 状态；迁移包保存其快照，不能将同名或旧路径的作品自动合并。SQLite 使用备份 API 导出并做完整性检查；不将 WAL/SHM 文件直接当作可移植数据库。

机器配置继续保留在服务器 `.vscode/settings.json`，Git 只保存示例。现有 Linux Runtime 是 `codex-cli 0.154.0`，pin 为 `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`，清单位于 `/opt/conda/envs/LitIsLand/lg-runtime/rust-v0.154.0/runtime.json`。它与本地 Codex 开发工具各自独立。

## 历史审计证据迁移

2026-10-16 清理了约 16GB Cargo 编译缓存和 1.6GB npm 下载缓存，将其余约 14GB 审计资料归档为：

`/root/private_data/image-layer-migration-20261016/LitIsLand-audits.tar`

同目录有 `migration.json` 与 `SHA256SUMS`。旧路线图中 `/opt/conda/envs/LitIsLand/audits/...` 路径是历史位置，目录已经迁出，不是当前代码依赖。按需从归档取证，不把整个归档解压回镜像层，不将大型编译目录提交 Git。

## 私有迁移包

持久化交接目录：`/root/private_data/LiteraryGiant-handoff-20261018/`。最终 `private-migration.tar.gz` 包含作品/状态快照、SQLite 一致性备份、可访问的 Codex 可见消息导出、机器路径清单及私有恢复说明。它不包含认证缓存、API 密钥、模型权重或 Library 语料。`MANIFEST.json` 记录导出范围、校验、排除项与最终提交；同目录 SHA-256 文件用于下载核对。

另外保留交接前的源码包、两个 Git bundle 和工作树补丁，以便恢复未提交基线。它们留在服务器，不随代码上传。

下载、隔离解压、核对和选择性恢复见 `local-development.md`。保留服务器原数据；不要将私有包直接覆盖到正在运行的目录，也不要用绝对旧路径注册 Mac 作品。

## 给下一位 Codex 的第一条消息

> 请先读取 AGENTS.md、README.md、docs/handoff.md、docs/conversation-context.md、docs/local-development.md，再读取 LiteraryAgent/AGENTS.md、docs/architecture.md 和 docs/roadmap.md。报告当前分支、父/子仓库提交、工作树状态和依赖检查结果。Mac 用于开发，服务器用于正式运行；Library/作品/凭据不在公开 GitHub 中。先确认我本次要做的任务，不自动推进所有路线图，不初始化或覆盖已有作品，不升级固定 Core。私有迁移包可在我指定的位置按需读取。
