# lg-planning

故事规划由独立 Cordis 服务 literaryPlanning、DSH 原生工具和作者面板组成。复用 lg-books 的 SQLite 事务；不依赖 Python、Codex Core，不另建权威作品库。

- **创作方向**：兼容 lg.creative-decision.v1；三项不同方案，保留原作者选择；选择绑定方案版本、选项和来源；撤回不回退历史。标题和主题身份固定；正式事实不随方向选择提升。来源允许当前草稿（计划依据），这不等于 Canonical 证据。
- **场景卡**：视角、时态、时间、地点、人物、目标、冲突、信息、情感、结束状态、字数范围。创建／编辑使用精确快照；修改已批准设计会要求重新批准，正文不变。
- **待审计划**：新提案保存在场景 metadata.lg_plan_proposal，保留已批准计划。批准时核对场景卡与正文版本；旧 scene_cards.plan 的 candidate/approved 状态可读。新操作保留历史与幂等收据。
- **层级与近期窗口**：作者创建卷／章空骨架；按同卷章节顺序查询未来 1–10 章，默认 3 章，拒绝顺序歧义。远期骨架与近期细化分开。不是自动展开全书或自动写作循环。
- **模型工具**：literary_plan 只读；literary_propose_plan 仅提交 decision.options 或 scene.plan，不选择、撤回、批准或采用。作者使用 POST /api/lg/planning 的 preview/apply。
- **上下文**：lg-context 可选已选方向、作用章节及场景设计；排除失效方向和待审替换计划；人物/读者模式不接入作者规划。方向变化会使依赖上下文的候选需要重新生成。

API 查询：documents、list(section=structure|decisions|scenes)、read、history、context、window。变更通过 preview/apply；重试保留 operation、change、token。

生产模块按边界拆为 common、decision-schema、decisions、scenes、structure、service、UI；规划事件表仅保存历史和操作收据，当前状态仍来自旧文档/场景表。

参考 [DOME](https://aclanthology.org/2025.naacl-long.63/) 的动态层级思路与 [ainovel-cli](https://github.com/voocel/ainovel-cli) 的近期展开机制；未引入其完整自主框架。尚未完成自动规划生成策略、跨卷重排、完整来源影响传播、旧候选 required_decision 审批迁移及投影审阅。桌面点击验收另见验证记录。

## 文学 Agent 生成入口

规划面板通过 lg-agents 提供三方案构思与场景计划生成；复用编辑台的上下文、Library 选择组件。可查看完整输入和费用预留，取消任务，返回记录后再进行作者裁决。安装包包含编译后的独立客户端，不要求安装 lg-workbench 才能加载该客户端。

生成来源收据存入方案版本元数据或待审场景计划；历史方案保持各自收据。作者选择／批准时通过可选的 lg-context 与 lg-library 服务重新校验；依赖服务缺失或来源变化时拒绝确认。生成新方案保留原选择，生成新场景计划保留已批准计划。`literaryPlanning.generated` 用于同一 Agent 操作恢复；`propose` 的第四个参数为受信任插件提供的生成证明，HTTP 与通用模型工具不接受该参数。

## 审阅入口

启用 lg-review 后，方向与场景记录支持审阅、查看证据、作者处理状态及按勾选问题要求改稿。报告来源过期后保留历史，但不能用于当前改稿。改稿的生成收据同时保留审阅约束来源，作者确认时复核。

结构变更确认后，配套 lg-books 会同步受影响的章节 Markdown。跨章移动分别记录原章与新章的结果；同章排序只处理一次。外部改稿由作者核对；文件故障可在规划历史或章节文件页重试。修改场景设计或待审计划不触发文件同步。
