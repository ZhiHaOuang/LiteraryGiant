# LiteraryGiant 项目审计报告

更新时间：2026-05-15

本报告基于当前仓库源码、LSF 作业脚本、配置文件和本地样例产物整理。目标不是简单介绍用法，而是回答三个问题：

1. 这个项目的文件脉络、工作逻辑和当前进展是什么。
2. 如果目标是“尽可能生成质量更好的长篇网文结构/内容”，当前项目有哪些严重问题。
3. 如果允许推翻已有实现，后续应该如何重新规划，才能得到更好的效果。

## 总体判断

`LiteraryGiant` 当前是一个离线长篇网文处理与生成实验管线，核心工作流是：

```text
TextM 原始小说
  -> scripts/Rename.py
RawData 标准化 txt
  -> hardmodel
ProcessData 规则切章结果
  -> softmodel + NuExtract
FeatureData 章节语义特征
  -> infermodel + Qwen
ClusterData 全局 plot/情节段库
  -> generatemodel + Qwen/DeepSeek
GData 新生成的 plot/chapter 语义 JSON
```

当前项目已经形成了四个 Python 包：

- `hardmodel`：硬规则预处理，负责读 txt、去噪、识别章节、输出章节 JSON。
- `softmodel`：章节级语义抽取，负责用 NuExtract 抽 summary、角色、场景、冲突、伏笔等字段。
- `infermodel`：情节段聚合，负责滑动窗口分析章节摘要、投票合并边界、输出 plot 库。
- `generatemodel`：从 plot 库采样，尝试生成新的 plot/chapter 语义 JSON，并用 critic 修订。

但当前系统离“高质量自动长篇生成”还有明显距离。它更像一个“结构化语义产物生成器”，尚不是稳定的“小说正文生成器”。最严重的问题是数据契约不一致、缺少测试和评估、模型失败会被静默 fallback 掩盖、生成阶段默认模型配置和本地权重不匹配，以及当前样例的 `FeatureData` 已经缺章。

## 当前项目进展

当前本地样例围绕一本书 `0001` 展开：

- `data/sources/raw_text/book_0001/`：canonical 原始文本副本和 metadata。
- `data/derived/chapters/book_0001/`：有 122 个章节 JSON，加 1 个 `index.json`。
- `data/derived/features/book_0001/`：有 120 个章节语义 JSON，加 1 个 `index.json`，缺少前两章 feature。
- `data/derived/plots/book_0001/`：已有 21 个 `plot_*.json`，另有 `index.json` 和 `window_results.json`。
- `data/derived/generations/`：生成阶段输出占位，尚未产出实际结果。
- `models/weights/`：本地模型权重约 187G，包含 Qwen、NuExtract、DeepSeek 等模型目录。

当前第三阶段 plot 从第 3 章开始。这不是正常完整链路，而是因为 legacy `FeatureData/0001/0001.json` 和 `FeatureData/0001/0002.json` 不存在，导致前两章没有进入情节聚合。

## 文件级脉络

下面按“源码文件”和“产物文件族”说明。对于 `0001.json` 到 `0122.json` 这类同构章节文件，按文件族说明，避免重复 122 次相同描述。

### 顶层配置与元数据

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `README.md` | 本报告。 | 当前工作唯一修改目标。 |
| `environment.litcodex-gpu-cu124.yml` | Conda GPU 环境权威来源，环境名 `LitCodex`。 | Python 3.12、PyTorch 2.4.1、CUDA 12.4，并通过 `-e .[local-models]` 安装项目和本地模型依赖。 |
| `pyproject.toml` | Python 包元数据、依赖、包发现规则和 console scripts。 | 替代旧 `setup.py` 与 `requirements.txt`。 |
| `.gitignore` | 忽略 canonical 数据、权重、运行产物、缓存和本地密钥。 | 真实 `data/`、`models/weights/`、`runs/` 内容不入库，只跟踪 `.gitkeep` 和框架文件。 |
| `.idea/*` | PyCharm 项目配置。 | 已被 Git 跟踪，但通常不应作为核心代码交付内容。 |

### `scripts/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `scripts/Rename.py` | 第 0 阶段预处理脚本。扫描 `TextM/*.txt`，自动猜编码，统一写入 `RawData/0001.txt` 这类编号文件，并维护 `RawData/states.json` 与 `retrieval_file/states.json`。 | 会清理旧的 `state.json`、`preprocess.json`、`step_*.json`。逻辑可用，但状态体系和 `.pipeline_state/state.json` 不是同一个新格式。 |

### `shared/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `shared/retrieval_tracker.py` | 新版流水线状态管理。提供 `compute_path_signature` 和 `PipelineState`，记录 book、chapter、step、input signature、output path、run stats。 | 有旧状态迁移逻辑，但当前 `.pipeline_state/state.json` 出现了同一本书的 legacy 记录和新记录并存。 |
| `shared/__init__.py` | 对外导出 `PipelineState` 和 `compute_path_signature`。 | 简单 API 门面。 |

### `hardmodel/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `hardmodel/rawtext.py` | 规则处理核心。定义 `RawNovelBook`、`ChapterRecord`、`ChunkRecord`，负责读取编码、文本规范化、噪声行识别、卷/章标题识别、章节切分、字数/段落/对话占比统计。 | 当前会把书名页识别成 `chapter_1`，样例第一章只有 `《平行万宙》` 6 个字符，属于明显数据质量问题。 |
| `hardmodel/processer.py` | 批处理和落盘封装。发现 txt 文件、调用 `RawNovelBook`、写 `ProcessData/<book_id>/index.json` 和每章 JSON。 | 默认输出根目录是 `processdata` 小写，但实际项目常用 `ProcessData`。 |
| `hardmodel/scheduling.py` | CLI 入口。解析参数，支持目录/单文件、chunk 参数、stdout、`.pipeline_state` 增量跳过和章节状态记录。 | 第一阶段状态记录较完整。 |
| `hardmodel/__main__.py` | 支持 `python -m hardmodel`。 | 调用 `scheduling.main()`。 |
| `hardmodel/__init__.py` | 包 API 导出。 | 导出核心类和处理函数。 |

### `softmodel/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `softmodel/schemas.py` | 定义章节语义 schema：`SemanticFeatures`、`EntityMention`，并提供宽松的 dict/list/text 归一化。 | 没有强校验，只做类型兜底。 |
| `softmodel/NuExtract_extractor.py` | NuExtract 推理封装。负责查找本地权重、检测后端、构造抽取 prompt、解析 JSON、补抽角色字段、补抽结构字段、分段生成 `detailed_summary`、清理 prompt 泄露。 | 文件最大、复杂度最高。每章可能触发多次模型调用，成本高；异常处理和 schema 校验仍不足。 |
| `softmodel/pipeline.py` | 章节特征流水线。把 `ProcessData` 章节上下文和 NuExtract 输出组合成 `FeatureData` 章节 JSON。 | 逻辑清晰，但完全依赖 extractor 成功与输出质量。 |
| `softmodel/processer.py` | 发现 `ProcessData` book、加载章节、逐章处理、写 `FeatureData`，并支持章节级 skip。 | 当前实际产物缺 `0001.json`、`0002.json`，说明处理/跳过/失败恢复存在缺口。 |
| `softmodel/scheduling.py` | CLI 入口。配置 NuExtract 模型、权重目录、输入输出、状态同步。 | LSF 脚本默认 `SYNC_PIPELINE_STATE=0`，多 worker 时不会写统一状态。 |
| `softmodel/__main__.py` | 支持 `python -m softmodel`。 | 调用 `scheduling.main()`。 |
| `softmodel/__init__.py` | 包 API 导出。 | 导出 extractor、pipeline、processer。 |

### `infermodel/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `infermodel/schemas.py` | 定义情节聚合的数据结构：`ChapterSynopsis`、`PlotWindow`、`LocalPlotSegment`、`WindowAnalysis`、`GlobalPlot`。 | 是 `FeatureData` 到 `ClusterData` 的结构桥梁。 |
| `infermodel/windowing.py` | 滑动窗口规划器。按章节顺序构造重叠窗口。 | 默认 20 章窗口、10 章重叠。 |
| `infermodel/summarizer.py` | Qwen 局部情节分析器。负责窗口切分 prompt、plot 摘要融合 prompt、边界验证 prompt、JSON 解析、fallback、summary coverage 估计。 | `analyze_window` 捕获所有异常并直接 fallback，模型失败可能不被发现。 |
| `infermodel/merger.py` | 将多个窗口的局部段落和候选边界合并成全局 plot。基于 hard/strong/weak/forbid 投票、边界验证和 fallback 摘要。 | 规则可解释，但阈值主要靠经验，没有评估集。 |
| `infermodel/pipeline.py` | 第三阶段总装。加载章节 synopsis、建窗口、分析窗口、合并 plot、对超长 plot 再细分、打质量分、输出配置。 | 能产出 `ClusterData`，但不写 `.pipeline_state`，重跑控制弱。 |
| `infermodel/processer.py` | 发现 `FeatureData` book、加载 index 和章节文件、写 `ClusterData/index.json`、`window_results.json`、`plot*.json`。 | 如果 index 声称 122 章但实际只有 120 个文件，不会强制报错。 |
| `infermodel/scheduling.py` | CLI 入口。配置窗口参数、Qwen 模型、边界阈值、细分参数。 | 只支持 `8b/14b` 预设，生成阶段支持更多模型。 |
| `infermodel/__main__.py` | 支持 `python -m infermodel`。 | 调用 `scheduling.main()`。 |
| `infermodel/__init__.py` | 包 API 导出。 | 导出 pipeline、schema、processer、merger 等。 |

### `generatemodel/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `generatemodel/schemas.py` | 定义生成阶段数据结构：`SeedChapter`、`SeedPlot`、`CritiqueIssue`、`GenerationCritique`。 | 主要用于把 `ClusterData` 和 `FeatureData` 变成生成输入。 |
| `generatemodel/model_runtime.py` | 本地聊天模型运行时。查找权重、加载 tokenizer/model、设置 device_map、推断 dtype、构造 max_memory。 | 支持多 GPU，但仍是 transformers 直接加载，长文本/大模型吞吐有限。 |
| `generatemodel/generator.py` | 生成器和批判器核心。`PlotChapterGenerator` 生成新的 plot/chapter JSON；`PlotChapterCritic` 审核候选并给 revision focus；模型缺失时可规则 fallback。 | 默认 critic 是 `DeepSeek_14B`，但当前 `models/weights` 只有 `DeepSeek_32B`，严格模式会失败。fallback 生成的是结构 JSON，不是正文。 |
| `generatemodel/pipeline.py` | 第四阶段总装。采样 seed plots、确定目标章节数、生成候选、critic 多轮修订、输出 book/plot/chapter manifest。 | 当前 `GData` 无实际生成产物。 |
| `generatemodel/processer.py` | 加载 `ClusterData` 和对应 `FeatureData`，构造 seed plot 库，写 `GData/<book_id>/index.json`、`plot*.json` 和章节 JSON。 | 如果找不到 feature 章节，会从 plot 的 `chapter_summaries` 合成简化章节。 |
| `generatemodel/scheduling.py` | CLI 入口。配置 generator/critic 模型、权重目录、生成数量、目标章节数、严格/回退模式。 | LSF 默认 `ALLOW_FALLBACK=0`，而默认 critic 权重缺失，直接提交大概率失败。 |
| `generatemodel/__main__.py` | 支持 `python -m generatemodel`。 | 调用 `scheduling.main()`。 |
| `generatemodel/__init__.py` | 包 API 导出。 | 导出生成 pipeline、runtime、schema 和 processer。 |

### `lsf_jobs/`

| 文件 | 作用 | 备注 |
| --- | --- | --- |
| `lsf_jobs/preprocess.lsf` | 集群提交第 0 阶段，运行 `scripts/rename.py`。 | 默认激活 `LitCodex` 环境。 |
| `lsf_jobs/hard_processing.lsf` | 集群提交第一阶段，运行 `python -m hardmodel`。 | 默认输出 `ProcessData`，同步 `.pipeline_state`。 |
| `lsf_jobs/soft_processing.lsf` | 集群提交第二阶段，支持多 GPU 多 book 并行运行 `python -m softmodel`。 | 默认 `NUEXTRACT_SIZE=4b`，当前产物 index 显示曾用 8B。 |
| `lsf_jobs/infer_processing.lsf` | 集群提交第三阶段，运行 `python -m infermodel`。 | 默认 `MODEL_SIZE=14b`。 |
| `lsf_jobs/generate_processing.lsf` | 集群提交第四阶段，运行 `python -m generatemodel`。 | 当前工作区已修改：资源从 8 核/8 GPU 改为 5 核/5 GPU，内存从 16G 改为 32G，并去掉了 `span[hosts=1]`。 |

### 数据与产物目录

| 路径 | 作用 | 当前状态 |
| --- | --- | --- |
| `TextM/平行万宙.txt` | 原始小说文本。 | 已存在，约 897K。 |
| `TextM/.gitkeep` | 保留输入目录。 | 已跟踪。 |
| `TextM/.DS_Store` | macOS 元数据。 | 不应进入项目产物。 |
| `RawData/0001.txt` | 标准化后的源小说。 | 来自 `TextM/平行万宙.txt`。 |
| `RawData/states.json` | `Rename.py` 的旧式状态。 | 记录 1 本书，检测编码 `gb18030`。 |
| `RawData/1_preprocess.json` | 预处理汇总。 | 显示 1 本书 100% 完成。 |
| `ProcessData/0001/index.json` | 第一阶段书级索引。 | 记录 122 章。 |
| `ProcessData/0001/0001.json` 到 `0122.json` | 第一阶段章节 JSON。 | 每章包含标题、正文、字数、段落数、对话占比等。 |
| `FeatureData/0001/index.json` | 第二阶段书级索引。 | 声称包含 122 章。 |
| `FeatureData/0001/0003.json` 到 `0122.json` | 第二阶段章节语义 JSON。 | 实际只有 120 个章节文件，缺 `0001.json`、`0002.json`。 |
| `ClusterData/0001/index.json` | 第三阶段 plot 索引和配置。 | 已产出。 |
| `ClusterData/0001/window_results.json` | 滑动窗口局部切分结果。 | 已产出，是调试边界的重要依据。 |
| `ClusterData/0001/plot1.json` 到 `plot21.json` | 全局情节段 JSON。 | 已产出 21 个 plot，但从第 3 章开始。 |
| `GData/.gitkeep` | 第四阶段输出目录占位。 | 尚无生成结果。 |
| `InferData/` | 旧或预留输出目录。 | 当前无文件。 |
| `models/weights/*` | 本地模型权重。 | 约 187G；有 `Qwen_8B`、`Qwen_14B`、`Qwen_32B`、`NuExtract_2B/4B/8B`、`DeepSeek_32B`，未见 `DeepSeek_14B`。 |
| `runs/`、`logs/.gitkeep` | 运行输出和日志目录占位。 | 当前无实际结果和日志。 |

## 各阶段如何组合成库功能

第一层是文本规范化与切章。`scripts/Rename.py` 把 `TextM` 中的任意中文 txt 做编码猜测和统一命名，写到 `RawData`。`hardmodel` 再读取 `RawData`，用规则清洗噪声、识别卷章、输出 `ProcessData`。这个阶段的作用是把“不可控的大文本”变成“每章一个 JSON 的稳定语料库”。

第二层是章节语义抽取。`softmodel` 读取 `ProcessData/<book_id>/<chapter>.json`，调用 `NuExtractExtractor`，得到章节摘要、角色、场景、目标、冲突、伏笔、线索、章末钩子、状态变化等字段，写入 `FeatureData`。这个阶段的作用是把“正文语料库”变成“章节级语义库”。

第三层是情节段聚合。`infermodel` 读取 `FeatureData` 的每章 summary/detailed_summary，先用滑动窗口让 Qwen 做局部情节切分，再用 `PlotSegmentMerger` 汇总边界投票，最终写出 `ClusterData` 中的 `plot*.json`。这个阶段的作用是把“章节级语义库”变成“中层情节库”。

第四层是新结构生成。`generatemodel` 从 `ClusterData` 采样若干 seed plot，并从 `FeatureData` 找回对应章节语义，交给 generator 生成新的 plot/chapter JSON，再交给 critic 做修订。这个阶段的作用是把“已有情节库”变成“新的结构化情节样本”。目前它还没有稳定产出小说正文。

## 严重问题

### P0：必须优先解决

1. `FeatureData` 与 index 不一致，已经影响第三阶段结果。

   `FeatureData/0001/index.json` 继承了 122 章清单，但实际只有 120 个章节文件，缺 `0001.json` 和 `0002.json`。`infermodel` 没有把这个视为错误，而是直接从存在的文件开始处理，导致 `ClusterData` 从第 3 章开始。这会让后续 plot 库和生成库永久丢失开头上下文。

2. 第四阶段默认严格提交会失败。

   `generatemodel` 默认 critic 是 `DeepSeek_14B`，`lsf_jobs/generate_processing.lsf` 默认 `CRITIC_SIZE=14b` 且 `ALLOW_FALLBACK=0`。但当前 `models/weights` 只有 `DeepSeek_32B`，没有 `DeepSeek_14B`。这意味着按默认 LSF 脚本提交时会在严格本地模型检查处失败。

3. 模型失败会被 fallback 掩盖，难以判断结果是否真实来自模型。

   `infermodel.summarizer.PlotWindowAnalyzer.analyze_window()` 捕获所有异常后直接返回 fallback。`generatemodel` 也允许模型缺失时规则 fallback。这样可以保证落盘，但会让产物看起来完整，实际可能只是规则拼接，质量评估会被污染。

4. 没有测试、没有评估集、没有质量基线。

   仓库中没有 test 文件。对于切章、schema、JSON 解析、缺文件检查、plot 边界、生成质量，都没有自动化回归。现在只能靠人工看样例，无法判断改动是否让效果变好。

5. 项目目标和实际输出不一致。

   如果目标是“生成可读小说正文”，当前系统只生成 plot/chapter 语义 JSON，不生成完整章节正文。即使第四阶段跑通，也只是结构层结果，不是最终可发布文本。

### P1：影响稳定性和可维护性

- 状态系统分裂：`Rename.py` 使用 `RawData/states.json` 和 `retrieval_file/states.json`，主流水线使用 `.pipeline_state/state.json`。当前 `.pipeline_state` 中已经出现 legacy 记录和新记录重复。
- 输出目录大小写不统一：代码默认有 `processdata`，实际目录是 `ProcessData`。文档、脚本、代码容易跑到不同目录。
- `.gitignore` 遗漏 `ClusterData`：当前 `ClusterData/0001/` 被 Git 标成未跟踪，容易误提交大量生成产物。
- NuExtract 抽取成本高：单章会做主抽取、结构补抽、角色补抽、详细摘要分段抽取。122 章会产生大量模型调用，且 `generate_text_batch()` 目前没有在主流程中使用。
- `FeatureData` 缺章时不 fail fast：第三阶段加载时没有检查 index manifest 和实际章节文件是否完全一致。
- 章节标题规则仍不稳：样例中第一章被识别为 `chapter_1` 且内容只有书名；部分标题出现转义痕迹，例如 `梦境沿\\`。
- 环境和包元数据已经收敛到 `environment.litcodex-gpu-cu124.yml` 与 `pyproject.toml`；后续不再维护 `setup.py` 和 `requirements.txt`。

### P2：设计层问题

- 当前 schema 偏“摘要字段集合”，不是完整的故事状态机。缺少实体别名归一、关系图、世界规则变迁、任务生命周期、冲突解决状态。
- plot 聚合主要依赖章节 summary，若 summary 错了，后续 plot 和生成都会被污染。
- 生成阶段没有真正的“全文写作循环”：没有章节正文草稿、风格一致性检查、连续性检查、读者吸引力检查和重写策略。
- 质量分数是启发式，不是由人工标注或稳定 benchmark 校准。
- 缺少人工可视化审阅工具。对于长篇生成，plot 边界、角色状态和伏笔回收很难只靠 JSON 文件检查。

## 如果追求最好效果，建议如何重做

如果可以推翻现有 coding，建议保留“分阶段产物”和“本地模型离线推理”的方向，但重做数据契约、评估体系和生成闭环。

### 目标重新定义

建议把项目目标明确成三层产物，而不是混在一起：

1. `Corpus Library`：从已有小说中抽取的章节、事件、人物、世界规则、plot 边界。
2. `Planning Engine`：能生成新小说的大纲、分卷、plot、章节计划和伏笔表。
3. `Drafting Engine`：能根据计划生成正文，并通过 continuity/style/reader-hook 评审循环重写。

当前代码主要覆盖第 1 层和部分第 2 层，没有覆盖第 3 层。

### 推荐新架构

```text
ingest/
  raw txt -> canonical chapters -> validated chapter store

extract/
  chapter -> events/entities/states/world_rules/hooks

index/
  symbolic index + vector index + entity graph + plot graph

plan/
  premise -> volume plan -> plot plan -> chapter cards

draft/
  chapter card + retrieval context -> prose draft

review/
  continuity critic + style critic + tension critic + factual/schema validator

revise/
  targeted rewrite -> accepted manuscript
```

这套结构比当前更适合高质量生成，因为它把“抽取已有文本”和“生成新文本”分开，把“计划”和“正文”分开，也把“模型输出”和“可验证数据契约”分开。

### 第一阶段：修正现有管线

目标是让当前代码先变成可信实验平台。

- 统一目录名：全部使用 `ProcessData`，移除小写 `processdata` 默认。
- 统一环境名：LSF 脚本默认 `CONDA_ENV_NAME=LitCodex`，或在 README 中明确改用一个环境。
- 补 `.gitignore`：加入 `/ClusterData/*`，保留 `!/ClusterData/.gitkeep`。
- 增加 manifest 校验：任何阶段读取 index 时，都要检查 manifest 文件实际存在；缺失即失败。
- 增加最小测试集：切章、中文数字解析、NuExtract JSON 解析、FeatureData 完整性、ClusterData 起止章节。
- 明确 fallback 标记：所有 fallback 产物必须写 `fallback_used=true` 和失败原因。

### 第二阶段：提升抽取质量

目标是让 `FeatureData` 从“摘要集合”升级为“章节状态记录”。

建议把每章拆成这些更稳定字段：

- `events`：事件列表，包含参与者、地点、动作、结果。
- `characters`：人物状态，包含心理、身体、目标、关系。
- `world_rules`：世界观/系统/任务规则新增或变化。
- `constraints`：时间压力、资源限制、敌对力量。
- `hooks`：伏笔、悬念、未解决问题。
- `resolutions`：本章解决了什么问题。
- `continuity_links`：与前文哪些角色/物品/伏笔有关。

NuExtract 可以继续用，但应从“单 prompt 大而全”改成“多任务小 schema + validator + retry”。抽取后用 Pydantic 或 JSON Schema 强校验，不合格就重试或标红。

### 第三阶段：重做 plot 聚合

目标是让 `ClusterData` 变成可靠的情节图，而不是只靠窗口摘要投票。

建议：

- 先用事件和任务状态做 deterministic segmentation，再让 LLM 验证边界。
- 每个 plot 保存 `goal -> obstacle -> escalation -> turn -> result` 五段结构。
- plot 之间保存边：因果、时间、伏笔、人物关系、世界规则依赖。
- 对每个边界保存证据章节和反证，不只保存投票分数。
- 建立人工标注的 20-50 个边界样本，用 Precision/Recall 评估阈值。

### 第四阶段：真正生成小说正文

目标是从结构 JSON 走向可读正文。

推荐生成顺序：

1. 先生成新书设定：题材、核心卖点、主角缺陷、长期目标、反派/压力系统。
2. 生成全书分卷计划：每卷目标、高潮、反转、升级点。
3. 生成 plot cards：每个 plot 的目标、冲突、信息增量、结尾钩子。
4. 生成 chapter cards：每章 POV、场景、事件、人物状态、必须回收的伏笔。
5. 生成正文草稿：每章按 card 写 2500-4000 中文字。
6. 多 critic 审查：连续性、人物动机、节奏、爽点、伏笔、语言风格。
7. 定向重写：只重写不合格段落，不整章盲改。

当前 `generatemodel` 可以保留为 planning prototype，但不应作为最终写作层。

## 近期可执行路线

### 立即修复

```bash
conda activate LitCodex
conda env update -n LitCodex -f environment.litcodex-gpu-cu124.yml --prune
python -m hardmodel data/sources/raw_text -o data/derived/chapters --chunk-size 1800 --chunk-overlap 300
python -m softmodel data/derived/chapters/book_0001 -o data/derived/features --weights-root models/weights --nuextract-size 8b --no-sync-state
python -m infermodel data/derived/features/book_0001 -o data/derived/plots --api-base-url https://token-plan-cn.xiaomimimo.com/anthropic --api-model mimo-v2.5-pro
```

执行后必须检查：

```bash
find data/derived/chapters/book_0001 -maxdepth 1 -name 'chapter_*.json' -type f | wc -l
find data/derived/features/book_0001 -maxdepth 1 -name 'chapter_*.json' -type f | wc -l
find data/derived/plots/book_0001 -maxdepth 1 -name 'plot_*.json' -type f | wc -l
```

`ProcessData` 和 `FeatureData` 的章节数必须一致，否则第三阶段不应继续。

### 第四阶段当前可跑命令

当前权重目录有 `DeepSeek_32B`，所以严格模式建议显式使用 32B critic：

```bash
python -m generatemodel data/derived/plots/book_0001 \
  --feature-root data/derived/features \
  --weights-root models/weights \
  -o data/derived/generations \
  --target-book-id 0001_generated \
  --seed-plot-count 3 \
  --generation-count 1 \
  --generator-size 14b \
  --critic-size 32b \
  --max-revision-rounds 2 \
  --strict-local-models
```

如果只是验证落盘结构，可以允许 fallback，但产物不能当作真实模型质量：

```bash
python -m generatemodel ClusterData/0001 \
  --feature-root FeatureData \
  -o GData \
  --target-book-id smoke_generated \
  --seed-plot-count 2 \
  --target-chapter-count 5 \
  --random-seed 7 \
  --allow-fallback
```

### 三周重构计划

第一周：可信数据链路。

- 补齐 `.gitignore`、目录名、环境名。
- 增加 manifest 完整性校验。
- 给 `ProcessData -> FeatureData -> ClusterData` 写 smoke tests。
- 将所有 fallback 显式写入 metadata。

第二周：高质量抽取。

- 设计新 `ChapterState` schema。
- 将 NuExtract prompt 拆成事件、人物、世界规则、伏笔四类。
- 加 JSON Schema/Pydantic 校验和 retry。
- 建 20 章人工审阅样本，记录抽取错误类型。

第三周：高质量生成闭环。

- 新增 `plan/` 和 `draft/` 两层。
- 从 plot 库生成 chapter cards，不直接生成最终 JSON。
- 生成 3-5 章正文样本。
- 加 continuity critic、style critic、reader-hook critic。
- 建立人工评分表，比较不同模型和 prompt 的效果。

## 最终建议

如果目标是尽可能好的效果，不建议继续把当前 `generatemodel` 扩成“直接生成整本小说”的单体模块。更好的方向是保留当前四阶段产物思想，但重做为“抽取库 + 情节图 + 计划器 + 正文生成 + 多 critic 重写”的闭环。

当前最值得保留的部分是：

- `hardmodel` 的基础切章和元数据落盘。
- `softmodel` 中对章节语义字段的经验 prompt。
- `infermodel` 中滑动窗口和边界投票的思想。
- `generatemodel` 中 generator/critic 分离的思路。

当前最应该推翻或重做的部分是：

- 缺少强校验的数据契约。
- 静默 fallback。
- 不完整产物仍能流入下游。
- 只生成结构 JSON、不生成正文的目标错位。
- 没有测试和评估的开发方式。
