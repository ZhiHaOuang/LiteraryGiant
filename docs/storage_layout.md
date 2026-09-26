# 源码、数据与运行产物的存储约定

本项目的工作目录同时容纳源码、模型和语料。工作目录大小不等于 Git
历史大小，也不等于平台镜像层大小：`/root/private_data` 是持久化位置。
忽略规则可以减少搜索和监听开销，但不会释放磁盘空间。

## 2026-09-16 初步盘点

以下为实际磁盘占用的近似值，使用 GiB/MiB 单位；大目录全量扫描可能很慢。

| 路径 | 占用 | 判断 |
| --- | ---: | --- |
| `Library/TaciturnHumanZip/` | 379 GiB | 已打包语料，原展开目录 `TaciturnHuman` 不在当前工作区，保留 |
| `models/` | 43 GiB | NuExtract_8B 约 16 GiB，Qwen_14B 约 28 GiB，独立四舍五入 |
| `runs/` | 5.9 GiB | 混合了实验与重要状态，不可整体删除 |
| `runs/processed-publish-staging-20260720/` | 3.8 GiB | 待核验的发布暂存，不等于已确认的重复副本 |
| `runs/fetch/` | 1.1 GiB | 抓取运行数据，需要核验正式语料覆盖情况 |
| `runs/novels-raw-mapping-repair-plan-20260722/` | 581 MiB | 迁移修复信息，默认保留 |
| `Library/Bridges/` | 813 MiB | 分析产物，默认保留 |
| `logs/` | 329 MiB | 历史运行日志，不能精确重建 |
| `LiteraryAgent/` | 83 MiB | 子模块源码及配套文件 |
| `.git/` | 77 MiB | Git 元数据，保留 |

这些行有父子包含关系，不可直接求和。清洗目录约有 27.6 万个书籍子目录，
抽查为 `index.json` 加逐章 `chapter_*.json`，不是 Python 缓存。

首批可重建缓存候选共 163 个文件、2,158,414 字节（约 2.06 MiB），
仅统计以下 10 个路径，尚未执行删除：

```text
Jormungandr/__pycache__/
Jormungandr/hardmodel/__pycache__/
Jormungandr/softmodel/__pycache__/
Jormungandr/infermodel/__pycache__/
Jormungandr/abstractmodel/__pycache__/
fetcher/__pycache__/
fetcher/adapters/__pycache__/
shared/__pycache__/
scripts/__pycache__/
tests/__pycache__/
```

## 目录职责

| 路径 | 用途 | 保留策略 |
| --- | --- | --- |
| `Jormungandr/`、`fetcher/`、`shared/` | 流水线源码 | 版本管理 |
| `scripts/`、`tests/`、`docs/` | 命令、测试与说明 | 版本管理 |
| `LiteraryAgent/` | 独立 Git 子模块；含上游核心 | 保留子模块结构，不当缓存删除 |
| `Projects/_template/` | 可复用创作模板 | 版本管理 |
| `Projects/` 的实际作品 | 草稿、设定与创作产物 | 持久化并备份；不是缓存 |
| `Library/` | 原始语料、清洗结果、分析与索引 | 持久化并备份 |
| `models/weights/` | 模型权重与分词器 | 持久化；记录来源、版本和校验值 |
| `runs/` | 实验、断点、迁移清单与暂存数据 | 按任务核验后归档或清理 |
| `logs/` | 运行日志 | 保留必要审计日志，设置轮转与保留期 |
| `.literarygiant/` | 本地运行状态，也可能含故事记忆与生成作品 | 不提交；不能整体视为可删除缓存 |

当前包发现配置与导入路径支持现有源码结构。仅为整洁而改成 `src/`
会引入导入和命令兼容成本，暂不迁移源码。

## 清理分级

- `__pycache__/`、`.pytest_cache/`、`.mypy_cache/`、`.ruff_cache/`：
  可由解释器或工具重建；在相关任务结束后，经批准可清理。
- `build/`、`dist/`：确认没有唯一发布包、源码与构建依赖完整后可重建。
- `*.egg-info/`：安装元数据；可通过重新安装生成，但直接删除可能影响
  当前 editable 安装的包元数据查询。不要和字节码缓存一起无条件删除。
- `runs/` 下 smoke、benchmark、tmp 名称只是候选线索，不是删除依据。
  先检查输入、命令、版本、输出用途和进程占用，保留需要的报告再清理。
- 原始语料、数据库、迁移 ID 映射、checkpoint、人工审核结果、故事记忆
  以及昂贵的 LLM 输出，默认保留。理论可重跑不代表重建成本可接受。
- 历史日志不能准确重建；只有确认不再需要审计和排障时才清理。

删除前列出具体路径、文件数、预计释放容量与重建方法，并获得批准。
不要使用 `git clean -fdx` 清理本项目：它会覆盖忽略中的真实数据。

## 后续大数据外置方案

可采用同一持久化卷上的并列目录（以下是建议布局，尚未创建或迁移）：

```text
/root/private_data/
├── LiteraryGiant/             # 源码仓库
│   ├── Library -> ../LiteraryGiant-data/Library
│   ├── models  -> ../LiteraryGiant-data/models
│   ├── runs    -> ../LiteraryGiant-data/runs
│   └── logs    -> ../LiteraryGiant-data/logs
└── LiteraryGiant-data/
    ├── Library/
    ├── models/
    ├── runs/
    └── logs/
```

迁移应在相关任务停止后进行，核对目标不存在、源目标在同一文件系统，
迁移后创建兼容链接，并验证项目读取路径。当前 Git 跟踪了部分目录中的
占位文件和历史日志，执行前还需明确它们的版本管理安排。
外置能隔离工作区，但不减少总容量或小文件数。

大量小文件应优先从数据格式解决：冷数据按批次打包归档并保留校验清单；
需要查询的数据可在适配读取器后改用按书/批次分片的 JSONL 或数据库。
不能直接打包或删除当前读取器依赖的章节文件。先在 LitIsLand 中对少量
样本验证读写、断点恢复与性能，再迁移完整数据集。
