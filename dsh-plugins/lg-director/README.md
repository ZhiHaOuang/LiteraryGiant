# lg-director

将 DSH 原生 Agent 的任务理解接入 LG 专家。模型调用 `literary_tasks` 检查能力／正文版本，调用 `literary_propose_task` 保存有界任务提议；作者在“文学任务”面板检查完整输入、范围与费用后执行。无额外路由模型、旧 Core、Python 后端或第二套 Agent loop。

服务 `literaryDirector`；作者 API `/api/lg/director` 提供 catalog/source/propose/list/read/preview/run/recover/stop。原生工具仅查询和提议，不能执行、停止、采用正文或确认事实。工具从 DSH workingDirectory 解析已登记作品，不能由模型传入另一个作品路径。正式采用仍通过现有文学面板。它不是对 DSH 通用文件／Shell 工具的安全沙箱，也不自动改变用户现有工具策略。

`input` 沿用 lg-agents 的任务参数：task、role、request、document/version/token/start/end 或 target、context、references、feedback、requirements、category。只允许当前目录中已支持的任务类型，具体角色和依赖通过 lg-agents.preview 校验。工具提议自身不调用模型；DSH 主会话及作者随后执行的专家调用各自按其执行配置计费。提议 ID 在重试时保持不变。

完整任务范围和预览签名保存到作品 SQLite 的 lg_director_tasks。作者执行时重新校验来源、偏好、角色与模型；同一任务编号沿用同一个执行器 operation。并发执行不重复请求，重启只恢复已成功的原调用；未知／reserved 结果只供检查，不重发。取消与插件停用中断在途调用，保留已有候选、原始结果和预算。新要求建立新提议，不用“继续”重置原任务。

每次提议只分派一个专家任务。没有自动选择创作方向、跨任务依赖调度、跨会话历史搜索、自动派生下一步或整体成果综合；现有有界多步流程仍由 lg-workflows 提供。旧 director 角色的完整工作流职责尚未迁完，不把此入口标为全功能 Director。

本插件没有将会话角色改成全局“总导演”，也不创建旧式专属子会话：自然语言理解、会话与工具循环属于 DSH；文学任务范围、候选和采用属于 LG。明确的单次任务仍可直接从章节编辑／规划等面板执行，避免无必要分派。

领域服务和工具不依赖网页连接；HTTP 作者接口通过 Cordis 可选 connection 子作用域注册。CLI/headless 与桌面共用同一领域实现。默认不改变其他工具或主会话提示词。

候选监督在原生会话中使用 literary_tasks 的 supervision 操作。传入已知的文档与候选版本，可读取本书要求的类别、状态与对应专家。将返回的 target 加上单个缺少或过期的 category，用 literary_propose_task 提议 candidate-analysis。作者在「文学任务」核对完整输入和费用后执行，结果带有版本化引文和设定依据，可打开对应版本继续审阅。
