# lg-library

LiteraryGiant 的文学资料检索插件。提供资料面板、Cordis 服务、作者 API，以及 DSH 原生 `literary_search` / `literary_reference` 工具；不依赖旧 Python Backend 或 Codex Core。

## 资料范围

- 作品必须先通过 `lg-books` 登记。
- `libraryRoot` 可配置共享 Library 目录；留空时只检查作品内普通 `Library` 目录，不跟随默认路径的符号链接。
- 首先检索 `AbstractLibrary/pattern_index.jsonl`、`AbstractLibrary/instance_index.jsonl`、`indexes/abstract_index.jsonl`。
- 然后检索作品 `ReferenceLibrary`；如存在已完成的 `lg.assets.v1` 组织清单，则仅检索其 `sources` 子目录。
- 结果不足时补充 `BridgeIndex/books/*.jsonl`。不读取 `TaciturnRaw` 或 `Bridges` 原始语料，不遍历计划、审阅、草稿、归档等目录。
- 参考文件支持 JSON、JSONL、Markdown、TXT。JSON 对象中的 `raw_text`、`content`、`chapter_text`、`source_locked_details` 不进入匹配、摘要或返回文本。

默认每次最多 300 文件、16 MB、20000 记录，单条记录最多 256 KiB；JSON 文件最多 8 MB，普通文本读取前 120000 字节。超过限制会明确返回截断标记。该版本为词项匹配，不是语义向量检索；不建立持久缓存或联网抓取资料。

## 接口

`literaryLibrary.catalog(path)`、`search(path, {query, limit}, signal)`、`read(path, citation)`。作者 API 为 `POST /api/lg/library`，对应 `catalog`、`search`、`read` 三个 action，沿用宿主认证。引用包含作品绑定、相对文件、记录位置及 SHA-256；读取时重新验证，来源变化必须重新检索。

DSH 工具从会话工作目录匹配已登记作品，不接受任意作品路径参数。工具结果仅为参考资料，不是 Canonical 事实，不执行正文写入或决定采用情节。插件卸载会移除服务、路由、工具并中止检索。

## 构建与验证

在父目录运行 `npm run build` 和 `npm test`。客户端必须使用 DSH 的经典脚本 factory，不能将 ES module 直接作为客户端资源。安装 `lg-books` 后，通过 DSH 插件管理器安装此包。

lg-workbench 可检索并选择最多 3 条资料交给 lg-agents；作者预览实际输入后才执行，引用在生成和采用前重新验证。当前尚未迁移旧 Library 的资料生成、分析卡写入、来源入库和作者知识投影。

## 文学方法分析卡

从 1–3 条明确选择的原始引用生成 EventsLibrary、PayoffAngst、CharacterArc、EmotionRhythm、Worldview 五类候选卡；单来源最多 4000 字符，引用位置针对过滤后文本。卡片保存在当前作品 SQLite，作者预览并批准后才进入检索；撤回或来源改变立即阻止使用。模型工具只读，不提供批准能力。检索复用 portable_core 与 fusion_hooks，不输出 implementation_details、source_locked_details 或原始证据。字段完整度不等于分析正确，仍需人工审阅。

对应服务：analysisSnapshot / validateAnalysis / saveAnalysis / analysisReplay；作者 API：contracts、cards、card、card-preview、card-apply。生成由 lg-agents 的 analyze-reference 单次有预算请求负责。五类字段沿用旧 reference-contracts.json，运行不依赖旧 Python 或 Codex Core。整卷报告与自动批量分析尚未迁移。

## 独立 Library 目录

优先从 literaryBooks.libraryRoot() 读取作者单独选定的 Library 目录；没有目录设置时保留原 libraryRoot 配置。沿用已有 AbstractLibrary、indexes 和 BridgeIndex 索引格式，不追加 Library 子目录，不扫描原始语料。
