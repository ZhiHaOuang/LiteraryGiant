# LiteraryGiant

一个围绕中文长篇小说构建的多阶段处理项目，目标不是“只抓数据”，而是把原始网文逐步转成可分析、可检索、可继续生成的结构化资产。

## 项目定位

当前项目的真实逻辑已经不是单一的抓取脚本，而是一条完整的数据生产链：

`站点抓取 -> 原始章节入库 -> 规则清洗/章节标准化 -> 章节语义特征提取 -> 全书情节分段 -> 基于情节库生成新内容`

它本质上是一个小说语料工厂，前半段负责“把脏数据变干净”，后半段负责“把干净数据变成抽象结构和生成素材”。

## 当前核心逻辑链

### 1. Fetcher：抓取与原始入库

入口：

- `python -m fetcher`
- `fetcher-run`

核心职责：

- 根据 URL 自动选择站点适配器
- 解析目录页、自动翻页、发现章节链接
- 并发抓取章节内容
- 在 `runs/fetch/<run_id>/` 下先做 staging
- 校验后再提升到 `Library/TaciturnRaw/novels_raw/` 或 `Library/TaciturnRaw/stories_raw/`
- 同步登记 `Library/indexes/books.json`

这一层解决的问题是：把离散、站点差异很大的网页内容，统一变成项目内部可消费的原始文本资产。

关键模块：

- `fetcher/scheduling.py`：CLI 调度入口
- `fetcher/engine.py`：抓取主引擎
- `fetcher/adapters/`：各站点解析规则
- `fetcher/registry.py`：原始书目注册表

输入：

- 小说目录页 / 章节页 / 故事集合页 URL

输出：

- `Library/TaciturnRaw/novels_raw/book_xxxx/`
- `Library/TaciturnRaw/stories_raw/story_xxxx/`
- `runs/fetch/run_index.json`
- `Library/indexes/books.json`

### 2. Hardmodel：清洗、去噪、章节标准化

入口：

- `python -m Jormungandr.hardmodel`
- `hardmodel-run`

核心职责：

- 识别输入来源是单文件、单书目录还是批量目录
- 对原始章节做规则去噪、章节标题识别、内容规整
- 可选接入弱噪声 LLM 分类器，处理规则难以判断的噪声行
- 将清洗结果写入 `Library/TaciturnRaw/novels_cleaned/`
- 使用 `cleaned_books.json` 建立 raw -> clean 的稳定映射
- 支持增量跳过、断点续跑、仅处理新抓取结果

这一层是整个项目最关键的“数据标准化层”。后续 softmodel / infermodel / generatemodel 都默认依赖这里产出的章节 JSON 结构。

关键模块：

- `Jormungandr/hardmodel/scheduling.py`
- `Jormungandr/hardmodel/source_resolver.py`
- `Jormungandr/hardmodel/chapter_cleaner.py`
- `Jormungandr/hardmodel/processor.py`
- `Jormungandr/hardmodel/manifest_writer.py`

输入：

- `Library/TaciturnRaw/novels_raw/...`

输出：

- `Library/TaciturnRaw/novels_cleaned/book_xxxx/`
- `Library/indexes/cleaned_books.json`
- `runs/pipeline_state/state.json`

### 3. Softmodel：章节级语义特征提取

入口：

- `python -m Jormungandr.softmodel`
- `softmodel-run`

核心职责：

- 读取 `novels_cleaned` 的 `index.json + chapter_xxxx.json`
- 为每章构建统一的 `chapter_context`
- 使用 NuExtract 模型抽取章节语义特征
- 产出可供后续情节识别使用的章节事实层
- 通过 `stage_queue` 和 done marker 支持优先队列与断点恢复

这一层开始从“文本清洗”进入“语义结构化”。它不是简单摘要，而是在为 infermodel 提供可滑窗聚合的章节语义摘要与特征。

关键模块：

- `Jormungandr/softmodel/scheduling.py`
- `Jormungandr/softmodel/pipeline.py`
- `Jormungandr/softmodel/processor.py`
- `Jormungandr/softmodel/nuextract_extractor.py`

输入：

- `Library/TaciturnRaw/novels_cleaned/book_xxxx/`

输出：

- `Library/TaciturnRaw/novels_chapter/book_xxxx/`
- `.softmodel.done`

### 4. Infermodel：全书情节分段与窗口融合

入口：

- `python -m infermodel`
- `infermodel-run`

核心职责：

- 基于章节特征构建重叠滑动窗口
- 调用外部 LLM API 对窗口进行情节分析
- 通过 boundary voting 合并窗口结果
- 对过长 plot 做递归 refinement
- 产出全书 plot segment、plot manifest、window manifest

这一层是全项目从“章节理解”到“全书结构理解”的桥梁。它把每章的局部语义，提升为跨章节的剧情段落、边界和摘要。

关键模块：

- `infermodel/scheduling.py`
- `infermodel/pipeline.py`
- `infermodel/windowing.py`
- `infermodel/summarizer.py`
- `infermodel/merger.py`

输入：

- `Library/TaciturnRaw/novels_chapter/book_xxxx/`

输出：

- `Library/Bridges/novels_plot/book_xxxx/`
- `.infermodel.done`

### 5. Generatemodel：从情节库生成新书

当前生成阶段仍是设计中的下游出口，尚未作为可运行 CLI 接入当前包入口。

核心职责：

- 从现有 plot library 里抽样 seed plots
- 根据 seed plots 生成新的 plot + chapter 草案
- 由 critic 模型进行打分和修订
- 支持 fallback 规则生成
- 将结果写入 `Projects/_generated/`

这一层说明项目已经不只是分析系统，而是在向“分析驱动的小说生成系统”演进。

关键模块：

- `generatemodel/scheduling.py`
- `generatemodel/pipeline.py`
- `generatemodel/generator.py`
- `generatemodel/processor.py`

输入：

- `Library/Bridges/novels_plot/book_xxxx/`
- 可选 `Library/TaciturnRaw/novels_chapter/`

输出：

- `Projects/_generated/<book_id>_generated/`

## 目录逻辑

项目目录可以按“层级职责”理解，而不是按文件名理解：

### 1. `Library/`

项目的长期知识库。

- `TaciturnRaw/`：沉默事实层，保存原始文本、清洗章节、章节语义事实
- `Bridges/`：桥接结构层，保存从章节事实上升到全书结构的中间产物
- `AbstractLibrary/`：抽象数据库，保存世界观、事件模块、人物线、情绪节奏、爽虐机制、热梗外壳和长篇逻辑图
- `indexes/`：注册表、索引、优先队列

### 2. `Projects/`

项目产物层。

- `_template/`：新书项目模板
- `_generated/`：生成模型产出的实验结果

### 3. `runs/`

运行态目录，不是知识库本体。

- `runs/fetch/`：抓取中间态
- `runs/pipeline_state/`：增量处理状态
- 其他 benchmark / tmp / log 目录：实验与调试辅助

## 数据流视角下的项目逻辑

如果从“资产流转”而不是“脚本调用”来看，整个项目的逻辑更清楚：

1. 外部网页内容先进入 `TaciturnRaw/novels_raw` 或 `TaciturnRaw/stories_raw`
2. `novels_raw` 被 hardmodel 变成规范章节事实 `TaciturnRaw/novels_cleaned`
3. `novels_cleaned` 被 softmodel 变成章节语义事实 `TaciturnRaw/novels_chapter`
4. `novels_chapter` 被 infermodel 变成全书剧情桥接结构 `Bridges/novels_plot`
5. `novels_plot` 被 generatemodel 重新组合，生成新的书籍草案

也就是说，项目的主干数据对象依次是：

`novels_raw -> novels_cleaned -> novels_chapter -> novels_plot -> 生成草案`

## 当前项目的优势

- 分层已经比较清楚，抓取、清洗、语义提取、情节聚合、生成彼此解耦
- 输出目录设计稳定，适合做增量处理和断点恢复
- `stage_queue + done marker + pipeline_state` 让批处理具备工程化基础
- `TaciturnRaw -> Bridges -> AbstractLibrary` 的拆分方向更贴合“事实沉淀、结构桥接、抽象复用”的创作链路

## 当前项目的主要问题

### 1. 文档和真实代码链路有些脱节

现在代码里已经有 softmodel / infermodel / generatemodel，但旧文档还停留在“第三阶段规划中”的表述，容易导致后续维护者误判项目成熟度。

### 2. 包结构存在新旧并存痕迹

目前同时存在：

- `Jormungandr/softmodel`
- `infermodel/`
- `generatemodel/`

再结合 `pyproject.toml` 和 git 状态，可以看出项目正处在目录迁移期。这个阶段最容易出现入口不统一、引用路径不一致、旧脚本残留的问题。

### 3. 事实层很强，但抽象层还没真正接上

`Library/AbstractLibrary/` 已经预留了七个抽象数据库，但当前主链路主要停在 `TaciturnRaw` 和 `Bridges`。也就是说，项目已经能抽取“发生了什么”，但还没有稳定沉淀“为什么这个结构有效”。

### 4. 调度能力有了，但全局编排还不够显式

现在每个阶段都能单独跑，也有 stage queue，但整个项目还缺一个“从 fetch 到 generate 的一键编排视角”，包括：

- 每阶段输入输出校验
- 失败重试策略
- 阶段依赖关系可视化
- 全局统计面板

## 后续建议

### 建议 1：先统一“官方主链路文档”

建议把当前 README 当作总览，然后补 3 个最关键的文档：

- `docs/pipeline.md`：阶段间输入输出契约
- `docs/data_schema.md`：各类 `index.json / chapter.json / plot.json` 结构
- `docs/ops.md`：常用运行命令、恢复命令、增量处理命令

这是当前收益最高、风险最低的工作，因为你的代码已经够复杂，文档不补齐，后续改动会越来越难控。

### 建议 2：统一命名和包边界

建议中期把阶段包全部统一到一种风格，例如都收口到：

- `Jormungandr.fetcher`
- `Jormungandr.hardmodel`
- `Jormungandr.softmodel`
- `Jormungandr.infermodel`
- `Jormungandr.generatemodel`

或者反过来全部平铺成顶层包，但不要混用。统一后，CLI、导入路径、测试目录、脚本依赖会明显简单很多。

### 建议 3：把 `Bridges -> AbstractLibrary` 做成正式阶段

这是项目真正能拉开差距的地方。建议新增一个明确阶段，例如：

`novels_chapter / novels_plot -> AbstractLibrary`

可以优先落地的抽象对象：

- 人物弧模板
- 冲突升级模板
- 爽点分布模板
- 常见桥段转场模板
- 世界观信息暴露节奏

这样 generatemodel 就不只是“采样已有 plot”，而是能显式利用可复用创作规律。

### 建议 4：补一个总调度脚本

建议做一个统一入口，例如 `pipeline-run`，支持：

- 从某个 URL 直接抓到 `Bridges/novels_plot`
- 从某个 book 继续跑剩余阶段
- 扫描所有 pending 项自动增量推进
- 输出每阶段成功/失败统计

这会让项目从“很多能跑的模块”升级成“真正可运营的流水线”。

### 建议 5：为每阶段定义完成条件

建议把“什么叫这一阶段完成”写死为程序契约，例如：

- `fetcher`：有 `index.json` 且章节文件数量满足阈值
- `hardmodel`：`chapter_manifest` 与原始章节数对齐
- `softmodel`：所有章节都存在 feature json，且索引完整
- `infermodel`：存在 `plot_manifest` 且 plot 覆盖全部章节
- `generatemodel`：存在生成结果索引，且 critique metadata 完整

这样后续的恢复、重试、补跑、数据审计都会简单很多。

### 建议 6：尽快补最小测试面

当前项目最适合先补的不是大而全测试，而是 4 类最小保护测试：

- 站点适配器解析测试
- hardmodel 去噪与章节切分回归测试
- softmodel / infermodel 的 schema 测试
- 目录发现、stage queue、resume 逻辑测试

这几类测试能优先防止“代码还在跑，但产物悄悄变坏”。

## 推荐使用顺序

### 单阶段运行

```bash
fetcher-run <url>
hardmodel-run Library/TaciturnRaw/novels_raw --use-clean-registry
softmodel-run Library/TaciturnRaw/novels_cleaned
infermodel-run Library/TaciturnRaw/novels_chapter --api-key "$MIMO_API_KEY"
```

### 更推荐的理解方式

不要把这个项目理解成“几个脚本的集合”，而要理解成：

一个以 `Library` 为知识底座、以 `TaciturnRaw -> Bridges -> AbstractLibrary` 为知识沉淀链路、以 `Projects/_generated` 为生成出口的小说语料与创作流水线。

## 一句话总结

当前项目已经具备了从网文抓取到结构化理解，再到受控生成的完整雏形。下一步最值得做的，不是继续堆新功能，而是先把链路文档、阶段契约、包边界和抽象层正式化，这样整个系统才会从“能跑”进入“可持续演进”。
