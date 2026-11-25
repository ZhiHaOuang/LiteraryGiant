# LiteraryGiant

中文长篇小说的数据处理流水线与 LG 写作 Agent 工作台。当前采用 **Mac 本地开发、Linux 服务器运行** 的工作方式。

## 仓库导览

- [DSH 本机开发](docs/dsh-local-app.md)提供框架构建与启动步骤，[插件目录](dsh-plugins/README.md)列出文学插件与第三方依赖。
- [Dashboard 实现审查](docs/dashboard-implementation-review-20261118.md)记录当前界面、调用链和仍待验证的问题。
- [故事资料契约](docs/story-data-contract-v1.md)和 [读写说明](docs/story-data-operations.md)覆盖书级资料、来源及导入工具。
- [开发与部署](docs/local-development.md)覆盖正文清洗、Python CLI、服务器更新和数据边界。旧写作后端、桌面端与 VS Code 扩展位于 `LiteraryAgent/`。

## 2026-11-25 源码版本

- [章节阅读审阅](dsh-plugins/lg-reading-review/README.md)把章节、版本和批注放在同一页面。作者可预览并确认正文编辑或保存候选。
- Dashboard 新增书架管理与工作区联动，支持新增、归档、恢复和移出登记。热力图、人物和书籍进度适配窄窗。
- [故事数据控制台](dsh-plugins/lg-storydata/README.md)提供协议目录、分书用量及人物、情节和环境资料。Agent Teams 可基于原文证据提议 Main 记录，由独立成员复核后提交。
- [四职责与上下文调研](docs/lg-agent-context-research-20261125.md)记录专项分析和缓存的设计与验证条件。当前开发入口见 [DSH 本机开发](docs/dsh-local-app.md)。

## Dashboard 资料接入与样例整理（2026-11-12）

三板块接入固定 `lg.story-data.read.v1` 读取接口和资料覆盖提示；书内 `notes/story-data/` 保存可校验、可重读的快照及整理记录。样例既有前20章资料由390条整理为411条，补人物阶段身份、时间关系和状态变化，全部保留为候选；正文与旧修订未变。隔离和实际项目各165项回归通过，实际组件／读取路由及离线重读通过。完整性评估、接口、文件布局和限制见 [Dashboard 资料说明](docs/story-dashboard-data.md)。保存工作后重启 App 加载新接口。

## 故事时间与人物历程 1.1（2026-11-11）

已补人物重要程度／叙事身份、故事时间范围及先后约束、人物状态前序检查，并接入 Dashboard 时间视图和事件前后认知上下文。样例书已备份迁移，正文与旧历史保留；未补造日期或确认候选。隔离与实际项目各 149 项回归通过，详情及容量边界见 [1.1 说明](docs/story-time-v1.1.md) 和 [当前交接](docs/handoff.md)。日常 App 保存编辑后重启加载。

## 文学 Agent Teams 初版状态（2026-11-11）

已安装到日常 LiteraryGiant App（现共 24 个插件），并实际点击验证三职责 Prompt／方法草稿、角色用量和完整候选；样例书 390 条资料中的人物、认知与情节梗概可展开。主项目 34 项相关回归、侧栏 133 项针对性测试及构建通过。真实请求最终 100/100（隔离实验 93＋日常验证 7），无剩余额度；v2.1 一个三职责案例交付 640 汉字。协作机制可运行，文学质量优势尚未证明。 详情与 Prompt 见 [实验与交付状态](experiments/agent-teams-v1/README.md)。下方记录按各自日期理解。

## 书级故事资料 v1（2026-11-11）

已交付 [13 类数据契约](docs/story-data-contract-v1.md)、[使用与复现说明](docs/story-data-operations.md) 和 [前 20 章实验报告](docs/story-data-experiment-20261111.md)。样例书新增 390 条候选，书级 Dashboard 支持分类、范围、关联、证据与历史查看；正文及旧状态未变。本轮费用保守上界 7.48 CNY，10 CNY 额度已结束，不自动延续。尚有实体重复、语义分类和跨章状态关联问题，未开始新 AgentTeams 插件。

## DSH 迁移记录（2026-11-07）

新的 LiteraryGiant 以 DSH / Cordis 作为宿主框架，通过插件逐项承接文学功能。源码已纳入本仓库：

- `dsh/`：固定上游版本的完整框架源码，包含此前验证过的 LiteraryGiant 桌面品牌改动。
- `dsh-plugins/`：文学插件与第三方源码快照。来源、版本与授权说明见 [插件目录](dsh-plugins/README.md)。
- `LiteraryAgent/`：原有文学实现与旧 Core 暂时保留，作为迁移和行为对照；新插件已开始逐项承接业务。

当时已交付 **17 个文学与执行策略插件**，日常 `/Applications/LiteraryGiant.app` 加上五个基础插件和品牌插件，共 **23 个插件已安装并逐项验证运行**。文学模型已配置，沿用原累计 ¥10 上限和已有账本。插件通过本仓库源码链接加载。

主要入口为小说控制台、文学编辑台、故事规划、文学工作流、故事记忆与文学资料。当前支持候选编辑与审阅、章节与场景生成、作者确认采用、章节文件同步、资料与记忆提取、专家设置、文学 Skills、作品导出。完整入口、预算和未迁移项见 [本次交付与体验](docs/dsh-delivery-20261107.md)。

隔离副本与项目各 318 项回归通过；17 个安装包的 207 个文件已与源码及隔离安装核对。旧整章候选经来源核验后可审阅、改稿和采用。整套包在 `.dsh-dev/plugin-packages/20261107-legacy-chapters/`。本轮收尾没有新增付费请求，也没有重新构建 DMG。旧 Core 的完整功能等价迁移与长篇质量验证仍未完成。下方 2026-10-22 记录描述原产品。

## 从这里接手（2026-10-22）

- [2026-10-22 产品交付与复现](docs/delivery-20261022.md)：已推送的产品版本、R5验收、认知证据校验、连接器精简及本地bundle。
- [同模型质量实验与预算](docs/quality-experiment-20261022.md)：智谱一次密钥配置、已执行的19次调用、费用估算与待作者审读的边界。
- [完整交接与当前进度](docs/handoff.md)：已完成能力、待办、数据边界和接手顺序。
- [Mac 开发与服务器更新](docs/local-development.md)：安装、验证、递归 clone、部署和恢复。
- [需求与对话决策摘要](docs/conversation-context.md)：供本地 Codex 读取的脱敏上下文。
- [2026-10-18验证记录](docs/validation-20261018.json)：本次实际执行结果；历史验收见子仓库路线图。
- [Codex 工作规则](AGENTS.md)：先读此文件，再读修改目录下的更具体规则。

本仓库包含两个 Git 仓库：父仓库承载数据流水线；`LiteraryAgent/` 是固定提交的独立子模块，承载写作 Agent、Python CLI 与 VS Code 扩展。不要只下载 GitHub ZIP。

```bash
git clone --recurse-submodules https://github.com/ZhiHaOuang/LiteraryGiant.git
cd LiteraryGiant
conda env create -f environment.yml
conda activate LitIsLand
python -m lg_cli --help
python -m scripts.validate_data_layout --help
```

已有环境可运行 `python -m pip install -r requirements.txt`。没有 Conda 时，可用 Python 3.12 的虚拟环境，步骤见开发说明。基础安装包含两个 Python 项目和表格导出依赖；模型权重、CUDA/vLLM 和产品 Codex Runtime 独立配置。

## 当前产品与完成边界

LG 写作工作台当前包版本为 0.3.0，但版本号本身不能表示后续未发布改动是否齐全。本次交接把此前工作树中的后端统一、API-only、Runtime 解耦、作者控制、来源校验和测试一并保存为 Git 提交。

CLI 与正式 Extension 共用 Literary Backend、作品数据库、会话和作者授权。Codex 与 Native 是执行适配器；Rust TUI 与独立 app_server 按既有作者决定保留为兼容入口。当前不是全部入口和 Runtime 能力均已对齐。

候选生成、采用正文和提升正式事实分别授权。不得把模型生成结果自动当成正式正文，也不得通过通用文件或 Shell 工具绕过故事内核的范围、版本和作者批准检查。产品 API-only；用户用于开发的 Codex 与产品固定的 Codex Core/Runtime 是不同安装，不能互相替代。

下一阶段主要工作是文学任务执行模型、完整信息可见性、来源变更后的依赖复核及真实长篇质量实验。准确的已实现/已测试/待实现划分见 [LiteraryAgent 路线图](LiteraryAgent/docs/roadmap.md) 与 [架构](LiteraryAgent/docs/architecture.md)。

## LG 开发入口

```bash
python -m lg_cli --help
python -m lg_cli -C /absolute/path/to/existing-book status
```

不要为了检查安装而对既有作品运行初始化或创建命令。API 凭据在各机器重新配置，不随 clone 或迁移包复制。开发扩展：

```bash
cd LiteraryAgent/lg-vscode
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Python 3.12、Node 20.18.1 / npm 10.8.2 是当前 Linux 验证基线。npm 使用已有 `package-lock.json`；依赖升级应独立验证。原生 macOS 实机与 ARM64 Runtime 尚未在本次 Linux 交接中验证。扩展使用方式、打包、集成测试及 Remote SSH 边界见 [开发说明](docs/local-development.md) 和 [扩展 README](LiteraryAgent/lg-vscode/README.md)。

2026-10-22已补Mac上的Python／Extension／Native合成HTTP验证；固定ARM64 Core的完整依赖元数据仍受原始Cargo.lock阻断，尚未编译。当前证据与历史Linux交接分开见 [产品交付](docs/delivery-20261022.md)。

## 数据流水线

| 阶段 | 实际模块/入口 | 主要产物 |
| --- | --- | --- |
| 网页、本地 TXT/EPUB 入库 | `fetcher`、`fetcher-run`、`novel-organize`、`epub-to-txt` | `Library/TaciturnRaw/01_RawData`、`00_Stories`、索引 |
| 清洗与章节标准化 | `Jormungandr.hardmodel`、`hardmodel-run` | `Library/TaciturnRaw/02_CleanedData` |
| 章节语义特征 | `Jormungandr.softmodel`、`softmodel-run` | `Library/TaciturnRaw/03_ChapterAnalysis` |
| 全书情节分段 | `Jormungandr.infermodel`、`infermodel-run` | `Library/Bridges/novels_plot` |
| 抽象资料抽取、物化与复核 | `Jormungandr.abstractmodel`、`abstractmodel-run`、`abstractmodel-materialize`、`abstractmodel-apply-review` | `Library/AbstractLibrary` 等抽象资产 |

各阶段的 LLM、权重和实际数据需单独准备；基础安装成功不等于 GPU 全流水线已验证。不存在可承诺直接使用的 `generatemodel` 发布入口；新书生成、候选审阅和作者采用目前应从 LG 产品入口理解。

| 目录 | 用途 | GitHub 范围 |
| --- | --- | --- |
| `fetcher/`、`Jormungandr/`、`shared/`、`scripts/`、`tests/` | 流水线实现与测试 | 上传 |
| `LiteraryAgent/` | 独立 Git 子模块，内含产品代码与 vendored Core | 上传源码、固定子模块提交 |
| `Library/` | 原始文本、章节事实、桥接与抽象知识库 | 数据留服务器；现有占位文件保留 |
| `Projects/` | 作品正文、资料、数据库和会话 | 私有迁移包 |
| `ReferenceLibrary/`、`.literarygiant/` | 本地参考资料与运行状态 | 私有迁移包 |
| `models/`、`runs/`、`logs/` | 权重、运行产物、日志 | 留服务器，不上传 |
| `docs/`、依赖入口和配置示例 | 接手续作、部署与验证 | 上传 |

## 数据与运行资料

- [存储布局](docs/storage_layout.md)
- [本地小说整理](docs/local_novel_import.md)
- [Library 冷存储](docs/library_cold_storage.md)
- [LG 作品布局](LiteraryAgent/docs/book-layout.md)
- [固定 Runtime 更新与构建](LiteraryAgent/docs/codex-core-updates.md)

2026-10-16 的环境整理已将历史 `LitIsLand/audits` 归档到持久化盘；它是历史验证证据，不是运行依赖。归档位置和迁移说明见交接文档。README 不把历史测试通过数当成本次执行结果。
