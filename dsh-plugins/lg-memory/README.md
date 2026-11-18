# lg-memory

故事记忆插件，复用 lg-books 的已登记作品与同一个 SQLite 数据库。提供故事记忆面板、Cordis 服务 `literaryMemory`、作者 API `/api/lg/memory`、DSH 工具 `literary_memory` 和 `literary_remember`。无需 Codex Core、旧 app_server 或 Python Backend。

## 职责

- **世界事实与提案**：使用旧 `story_facts`、`fact_proposals`、`fact_history` 表；提案、作者采用、正式确认、按分类/键更新和归档分开。正式事实要求当前已采用来源，或由作者确认的独立设定。来源过期不会自动撤销作者状态；工具不会把过期来源的事实作为当前依据返回。
- **时间线**：时间标签与显式排序键，保存设想/正式/归档等状态；不从自然语言自动推断时间。旧表只绑定文档，不保存精确版本，面板中的时间事件不等于已验证世界事实。
- **伏笔**：计划埋设、待回收、回收、放弃；保留埋设与回收说明和关联文档。处理结果由作者预览确认。
- **叙事认知**：沿用 `documents.kind=narrative_knowledge` 和 `lg.narrative-knowledge.v1`，保留完整版本。提出新版本保留旧确认，确认绑定精确历史提案版本，撤回不回退到旧确认。人物的“相信”允许与世界事实不同；不自动提升为 Canonical。

人物使用故事位置，读者使用阅读位置；坐标由作者定义，不是自动解析的日期或章节号。相同主体/主题的已确认区间不能重叠。投影只返回区间内、已确认且来源有效的登记认知，排除作者理由和未确认修订。来源过期保留记录并单独报告待复核，不展示其内容。覆盖范围仍可能不完整，此投影不隔离其他工具、会话历史或模型已有知识。

## 写入与接口

作者变更先 `preview(path, change)`，再 `apply(path, change, token, operation)`。预览绑定当前记录和来源状态，变更后需重新预览。每次提交在 lg-books 的同步事务中完成，`lg_memory_operations` 只保存幂等收据；并没有第二份权威故事库。记录和确认都可追溯；不删除作品数据。

模型写工具只允许 `fact.propose` 和 `knowledge.propose`，不能确认事实、认知或修改时间线。工具从会话目录匹配已登记作品。`literary_memory` 明确区分 world / character / reader；后两者要求位置，人物还要求精确人物文档。另有 author 模式，供作者协作任务读取完整提案和最新版本后提出修订；它包含作者材料，不能当作人物或读者已知内容。角色层的工具可见性仍须由后续执行与上下文插件约束。

作者 API 的 action：`list`（facts/proposals/timeline/foreshadowing/knowledge）、`record`（按 ID 读取）、`documents`、`history`、`view`、`preview`、`apply`。领域 action：`fact.add/set/propose/promote/archive`、`proposal.accept/reject`、`timeline.add/update`、`foreshadow.add/resolve`、`knowledge.propose/confirm/withdraw`。来源参数采用精确版本 ID；认知确认参数采用提案版本号，两者明确区分。

列表支持关键词、状态、事实分类和精确标签筛选，使用 offset/limit 分页；认知关键词匹配标题/标识。提案默认显示 proposed，status 为空可列出全部。事实历史也支持分页，避免只看到最近变更。

## 当前限制与验证

列表分页、认知扫描及输出均有上限，截断会标明。当前是已登记故事状态的管理和投影；旧 Markdown 记忆文件、`.learnings`、作者长期偏好、派生文件导出及任务上下文自动装配尚待相应插件迁移。时间线和伏笔沿用旧表，尚无版本化来源证明。桌面点击验收需解锁 Mac；宿主加载和作者 API 单独验证。

从父目录运行 `npm run build`、`npm test`。插件测试覆盖作者确认边界、事务与重试、旧表结构、来源过期、认知版本和区间、视角不泄漏、真实 DSH ToolsService 及卸载/重载。


## 从正文提取待审事实

记忆面板可选择当前已采纳章节／场景的精确范围（最多 12000 字），经 lg-agents 的 extract-memory 单次任务生成最多 8 条提案。完整输入与预留费用先显示；句段编号由程序转换成精确版本、字符范围和原句。提案与证据批次在同一作品事务落库，重复操作不会重复生成。人物对白、猜测和计划不得当作世界真相；证据定位不是语义正确性证明，作者须逐条核对并确认。

提案的作者确认继续使用原入口，生成路径没有确认权限；来源／提案变化会拒绝采用，旧证据保留供复核。lg_memory_evidence 只保存生成提案的来源收据，正式事实仍在原 story_facts。不会自动更新人物认知、读者知识、时间线或伏笔；这些仍通过各自审批入口处理。关闭 lg-agents 后，已有提案与人工记忆操作仍可使用。
