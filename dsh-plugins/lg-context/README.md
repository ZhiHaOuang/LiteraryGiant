# lg-context

通过 Cordis 的 literaryBooks / literaryMemory 装配有大小上限的文学上下文，无 Python 或旧 Core 运行依赖。

- 作者模式显式选择最多 8 份文档，以及事实、设想、时间线、伏笔、固定笔记开关。没有默认全书扫描；创作决策与认知文档必须走专用服务。
- 人物／读者模式仅取指定故事／阅读位置的已确认认知。不会自动混入作者笔记、世界事实、待确认修订或其他人物知识；选区、作者要求、其他工具与会话历史不属于此隔离保证。
- 每次模型材料序列化上限默认 4000 字节（可选 1000–12000），每项最多 1200 字节，并记录截断、遗漏、精确来源与实际片段摘要。总模型输入仍受 lg-execution 上限约束。
- 文档仅用当前活动版本，草稿有明确标签。笔记只读固定九份 Markdown 和最多八份 .learnings/*.md；单文件上限 256 KiB，拒绝符号链接，不读取原始语料。
- literaryContext.build/verify 提供来源收据；lg-agents 在执行前后检查，lg-books 在作者采用时再次检查。来源失效保留生成结果，拒绝采用旧候选。
- 工具 literary_context、API POST /api/lg/context（build/documents）；编辑台直接复用此服务，没有第二套控制台。

已通过可选 literaryPlanning 服务接入 decisions 开关、chapter 作用范围与 scene 场景卡；只装配有效作者选择，排除待审替换计划。未覆盖：自动相关性排序、全量依赖影响、整次通用 Agent 会话的信息隔离。候选/事实确认继续由作者操作。
