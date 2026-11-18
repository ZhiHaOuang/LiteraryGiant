# 文学作品服务

提供作品目录校验、活动正文读取、书籍统计和受控版本事务，不依赖 Codex Core。

版本 0.1.0。Host 使用 DSH Cordis 生命周期和已认证的 connection.fetch；不启动 Python、Codex 或额外服务器。

兼容 lg.story-project.v1 / lg.story-database.v1。作者在控制台添加目录；作品列表存于插件配置。控制台支持新建空作品：预览后创建兼容数据库、9 份基础笔记及资料目录，并通过 DSH 配置登记；重复提交不重置已创建作品。完整旧审批规则迁移尚未完成。

`literaryBooks` 服务提供 list / snapshot / manuscript / candidate；不向模型暴露正式采用接口。受认证的作者 API 支持 edit / candidate / accept / reject：整章快照检查、事务、精确候选和幂等收据。旧规则候选采用暂时拒绝。保存当前正文或采用候选时先提交 SQLite 版本，再同步整章 Markdown。外部修改或未登记的文件留待作者比较，文件系统错误可按原收据重试。仅在合成作品验证写入，未修改用户小说。

开发与验收入口见上级 package.json。
# 参考资料来源校验

由 lg-agents 生成且带参考资料的候选，采用前须通过 lg-library 校验引用内容。来源变更或服务不可用时拒绝采用；无引用的手工编辑和候选不受影响。底层 `writeManuscript` 通过可选校验回调完成这一边界，不直接依赖 Library 实现。

## 插件共享状态接口

`literaryBooks.readState(path, callback)` 与 `changeState(path, callback)` 为受信任的 Cordis 插件提供同步 SQLite 事务。作品必须已登记，仍校验项目与数据库身份；读取使用只读连接，写入统一提交，异常自动回滚。回调不得跨异步边界。这两个接口不暴露给模型工具或 HTTP 客户端，领域插件各自约束其允许的作者操作。


## 原生创建与作品资料

`/api/lg/books` 增加 `create-preview`、`create`、`integrity`。创建仅接受不存在或完全为空的目录，上级目录须存在；拒绝符号链接，使用创建收据保留重试身份，最后发布项目 manifest。中断造成冲突时保留现场，不覆盖已有文件。完整性检查覆盖 SQLite、外键、活动版本归属和项目身份，不代表文学语义正确。

`literaryBooks.documents` 提供 list / read / preview / apply；作者 HTTP 入口为 `/api/lg/documents`。人物、世界观、大纲、文风等资料可新建、修改、保存候选、采用、拒绝、恢复历史、归档和恢复显示。历史恢复先生成新候选；采用须再次确认；基于当前资料 token 与预览签名防止过期写入。标签、标题与版本历史保留，分页检索不读取 Library 原始语料。模型侧 `candidate` 服务只保存已有资料的候选，不提供正式采用或新建作品工具。

章节／场景正文、方向裁决与角色认知继续使用专用插件入口。带旧 required_decision / generation_sources 的版本拒绝直接采用或恢复；派生外部文件同步、全量导入导出、项目重命名和完整旧审批兼容仍待实现。资料 UI 在文学编辑台的「作品资料」页；数据库与真实宿主 API 已验证，原生点击验收待 Mac 解锁。

反馈改稿候选采用前需要 lg-review 复核问题和原材料。对未采用候选再改稿时，继续检查来源链中每个候选的计划、上下文、参考资料与反馈；旧审批标记、已拒绝源候选、过期正文和超过 32 层的来源链均拒绝自动采用，避免通过二次候选丢失原审批条件。

章节文件同步位于文学编辑台的「章节文件」。支持旧版 Markdown 标记与同步基线。确认导入会在同一事务保存所有变更段落及回执。双侧修改需选择保留的一方或先手工合并。更新磁盘文件时，原件留在作品的 `.literarygiant/chapter-sync-backups/`。新基线存于作品 SQLite，旧 CLI 不读取这份基线。

旧版章节导入中断时，编辑台会检查日志、历史版本和逐段正文摘要。若已提交，确认后登记原导入基线并更新相关全文检索条目。若尚未提交且文件与原快照一致，确认后继续原导入。恢复收据保存在作品 SQLite，旧日志保留供核对。

控制台的「故事索引」按需读取已登记作品。人物关系和事件连线保留来源及当前版本。材料索引须通过文件哈希校验。预览后可重建 `ReferenceLibrary/indices/story.json`，替换时保留原件。遇到未校验的旧章节分析报告或损坏的来源记录时，界面列出缺口，保留现有磁盘索引。

旧章节人物弧光与事件报告按源快照、存档格式和原文引证校验。可展开查看章节、场景或作者选定方案的原句及版本 ID。正文或方向变化后报告退出当前索引；只变更正式设定时标为待复核。无效引文或不兼容契约会阻止覆盖现有索引。lg-books 所带 analysis-contracts.json 固定自旧程序的 chapter-analysis.schema.json 及 CharacterArc／EventsLibrary 存档实例卡契约，运行时使用 Ajv 2020 校验。

采用 LG 原生候选时读取作品已有的 .literarygiant/supervision.json。受监督的书须具备要求类别的候选审阅报告，核对原章、采用后整章、正式设定与适用创作方向。acceptance-review 在回滚的事务中显示证据；adjudicate-supervision 在作者署名并确认理由后记录兼容旧版的不可覆盖裁决。accept 在提交前重复核对。已有旧候选自身的审批契约继续按原规则处理。编辑台可预览并生成缺少或来源已变化的章节候选报告。每份报告与本次正文版本、选定方案和正式设定绑定；已采用候选的分析按章发布。

发布沿用采用收据核对原章、当前章及每份候选报告的摘要。可在「章节文件」查看最近一次监督采用的各类发布结果，重试待发布项。替换本章已有报告时将原件保存到作品的 .literarygiant/analysis-backups；来源变化时停止剩余发布。

新作品默认写入与旧版兼容的五类章节监督策略。旧创建收据按当时的预览恢复。已登记作品可从控制台启用监督，已有策略和作者裁决原样保留。

原 Python 整章任务生成的 lg.literary-task.v1 候选可从历史快照或编辑台采用。作品服务复核候选输出、读取时的原章内容与状态，并用原 Python 的规范 JSON 摘要核对指定方向。采用预览绑定这些依据，本书现有监督与裁决仍然生效。基于该候选的原生改稿保留旧候选绑定与旧版可识别的 required_decision。

## Books 与 Library 独立目录

`booksDirectory` 与 `libraryDirectory` 分别保存作者选择的现存目录，可以位于不同位置。Books 直接浅层发现其中的 LG 格式作品，并通过原生 workspaceRegistry 幂等登记；Library 直接提供现有标准索引。选择目录不会追加 Books/ 或 Library/，不会创建、移动或删除文件。旧 rootDirectory 仅作为读取旧路径的兼容项；重新保存后使用两项独立配置。

`POST /api/lg/books` 的 `shelf` 返回路径、作品、索引状态和 workspace 错误；`configure-directories` 接受 booksDirectory、libraryDirectory 并一起保存。只更改其中一项时保留另一项。对话按书籍 workspace/cwd 归属，记录仍由 DSH home 持久化。
