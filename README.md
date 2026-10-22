# LiteraryGiant

中文长篇小说的数据处理流水线与 LG 写作 Agent 工作台。当前采用 **Mac 本地开发、Linux 服务器运行** 的工作方式。

## 从这里接手（2026-10-22）

- [2026-10-22 产品交付与复现](docs/delivery-20261022.md)：已推送的产品版本、R5验收、认知证据校验、连接器精简及本地bundle。
- [同模型质量实验与预算](docs/quality-experiment-20261022.md)：智谱候选型号、首轮5元建议、配置方式与尚未执行的边界。
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
