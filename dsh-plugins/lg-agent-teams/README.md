# LG 文学 Agent 预设（preset-v1）

使用 DSH 原生 AgentLoop、subagents.startActivation 和自动成员回报。主 Agent 与作者讨论，并按需委派分析、规划、创作；简单讨论不创建成员。无自制模型循环，不改 Runtime，不依赖 Dashboard。

## 四个原生预设

| 预设 | 职责 | 执行方式 |
|---|---|---|
| `lg` / LG 主 Agent | 与作者讨论；可以直接处理短任务，按需委派 | Standard 衍生的 Native 工具调用 |
| `lg-analysis` / LG 分析 | 选择相关维度，区分事实、人物信念、推断、未知，附原文证据 | Native；仅上下文读取与分析提交 |
| `lg-planning` / LG 规划 | 场景目标、人物选择、后果与取舍；默认一个候选 | Native；仅上下文读取与规划提交 |
| `lg-writing` / LG 创作 | 按指定来源与作者要求写完整候选正文 | Native；仅上下文读取与创作提交 |

使用 DSH 原生 preset 注册器与 Native executor，保留会话、取消、自动成员回报、上下文压缩、结果裁剪及主 Agent 澄清。没有复制或修改 AgentLoop。四份新提示词见 [主 Agent](presets/prompts/coordinator.md)、[分析](presets/prompts/analysis.md)、[规划](presets/prompts/planning.md)、[创作](presets/prompts/writing.md)。组合入口是 [presets/index.js](presets/index.js)。

当前三个成员仅需读取一次限定上下文并提交，尚无证据表明 PTC 的代码编排能带来收益，因此先统一 Native，保留以后单独比较 PTC 的可能。Creator 不接入；人物侧写的 Minimal 预设尚未实现。本版不注入旧 methods，不新增 Skill，不强制三成员流水线，也不把文学质量提升当作已验证结论。

在已登记作品的**新会话**选择「LG 主 Agent」；已有有内容会话遵守 DSH 原生预设切换限制。安装插件会添加四个选项，不改变全局 Standard 默认。三个成员只能由主 Agent 创建，单独选中后发送消息会在调用模型前拒绝。未绑定作品的 LG 会话也在请求前拒绝。

在已登记作品的新会话中，例如：

> 只阅读第 2、3 章。先分析人物认知，再规划一个建立信任但各有保留的场景，试写 500—700 汉字；不把沉默写成同意，不引入新能力。所有内容仅为候选。

主 Agent 可 prepare → source → 直接回答，也可 prepare → 按需 delegate → 自动回报 → result；catalog 查询职责，需要时 cancel 或 ask_user_question。直接回答保留在 DSH 会话历史，只有成员 submit 写入独立协作候选。成员只能 context + 自己的 submit。准备来源冻结章节、版本、作者要求和汉字范围；上游制品必须来自同一会话、同一来源且已完成。每次最多 8 章、120 KB 上下文、3 个并发成员；日常 beta 不设总请求或单成员请求次数上限；实验模式才执行次数限制。

分析引文由程序验证章号、段落、原句，并绑定真实 document/version/hash。它只证明引用存在，不证明解释正确。写作按 Unicode Han 字符计数，标点、数字、空白不计；失败反馈要求重新提交完整对象。

## 状态与边界

任务、候选、请求用量保存在 profile 的 lg-agent-teams/teams.sqlite3（或配置的 stateDirectory）；DSH 继续保存会话。书级数据库和正文不被本插件写入。所有方案和正文均为候选，没有采纳、确认事实或修改长期规划的工具。

默认 activation=preset，仅 LG 主预设及其受派成员启用文学规则，普通 Standard 不再因位于书籍目录而被接管。工具白名单绑定具体会话，执行守卫由预设与任务服务共同检查；不能用通用工具绕过候选边界。当前成员不能使用 shell、任意文件访问、其他插件的写入工具或自行创建下一层成员。每个角色独立上下文，不继承作者完整聊天。读取的故事资料仅包含本次选定章节内、来源有效的记录，候选身份保持不变。模型自身可能记得原小说后文，程序无法消除预训练记忆。

状态来源变化后旧任务不能继续提交；历史候选仍可查看。中断不自动续费或重试，冷启动将失去活跃执行的任务标为已中断。重放相同 operation 返回原任务；内容不同会拒绝。任务库有单宿主占用保护。

## 配置与安装

作为 DSH Host 插件安装，依赖 lg-books 及宿主的 agents、subagents、tools、systemPrompt、llm 服务，使用 spawn 提供器。package.json 和 cordis.patch.yml 提供安装入口。安装与 profile 修改前退出桌面 App；已有模型凭据仍由 DSH 管理，不放入此插件配置。

配置项：stateDirectory 默认当前 profile 的 lg-agent-teams。产品 bundle 默认 budgetMode=usage，日常使用仅计量，忽略遗留的 budgetId/requestLimit，不受旧实验关闭标记影响；新请求记入 interactive-usage 分区，旧请求和预算原样保留。实验须显式配置 budgetMode=limited、独立 budgetId 和 requestLimit（1—100）；未指定模式时为 auto：带 profileContext 的正式宿主仅计量，裸程序实验挂载仍限额，兼容旧 profile 整段覆盖配置的情况。带完整 profile 的实验也必须显式 limited。provider/model 留空继承主 Agent，当前验证固定 DeepSeek 账号 / deepseek-flash；activation 默认 preset；显式 registered-book 仅供旧流程回放与兼容，沿用旧 prompts/ 和 methods/。methods 只控制旧流程是否附加方法草稿，新预设始终不附加。成员 reasoningEffort=off，maxTokens=6000。

两种模式都在 llm/stream 调度时记录请求，失败、未知用量和中断均保留。usage 返回 limit=null、remaining=null，表示不设额度，不是零额度。limited 模式才检查总上限、每成员每预算最多6次及预算关闭状态，重启不重置计数。真实实验的账号适配器设置 maxRetries=0，避免隐式重试；不能将其他适配器内部 HTTP 重试当成已逐次计量。主 Agent 与成员分别累计，输入含缓存 Token，不估造费用。

Dashboard 通过只读 /api/lg/teams 查看角色 Prompt、方法草稿、按日期/作品筛选的请求和 Token 占比，以及完整候选、来源和字数。隔离实验任务有明确标签；实验用量不并入旧 Context 图，不能相加当总账。

## 免费验证

先按仓库说明准备 Node 24 与已构建的固定 DSH，然后在仓库根运行：

```sh
.dsh-dev/node/bin/node --test dsh-plugins/lg-agent-teams/tests/*.test.mjs
.dsh-dev/node/bin/node dsh-plugins/scripts/build.mjs lg-dashboard
```

原生循环测试使用真实 DSH 调度、工具和成员回报，仅模型响应为脚本替身；不需要凭据或模型费用。隔离测试可用 LG_DSH_ROOT 指向仓库 dsh。实验报告另见 ../../experiments/agent-teams-v1/README.md。

## beta 用量与实验额度分离（2026-11-12）

作者日常测试不受实验预算限制。产品 bundle 使用 usage，实验驱动使用 limited；主 Agent、成员及辅助请求继续统一计量，候选和作者控制规则不变。无需清空旧账本、重开旧预算或修改凭据。已链接源码的日常 App 保存后重启加载。

专项回归覆盖同一成员120次模拟请求及重开后第121次，已关闭旧实验记录逐字保留，有限实验仍会按额度拒绝。独立实际 App 宿主验证故意保留 requestLimit=1 的旧配置，完整15次模拟请求仍成功并全部计量；没有外部模型调用。

## 本轮验证（2026-11-11）

LitIsLand 隔离副本与实际项目各通过 45 项测试，覆盖真实预设注册、三职责独立派发、直接阅读、过期来源、普通 Standard 不受接管、空会话切换、先选 LG 后选作品，以及请求上限。模型接口为脚本替身。

已安装 LiteraryGiant.app 的 CLI 在两个独立 profile 分别加载隔离源码和实际项目源码，完整现有插件集共存；四个 LG 预设无 broken，三个成员以对应预设完成候选。每次 15 个模拟请求（含1个标题请求）全部计量，工具错误0，真实模型请求0。结果与同步前备份位于本机 LitIsLand 的 audits/lg-presets-20261111。日常 App 没有强制重启，保存后重启加载；没有修改其默认预设、凭据或预算。

## 本版尚未证明

三角色协作提升文学质量、方法草稿的因果收益、百万字持续创作与复杂人物认知隔离仍未验证。新预设配置没有消耗真实模型额度，也没有重置或扩大旧预算。分析报告尚未自动导入 13 类书级资料；Dashboard 的旧故事资料与本插件候选分别展示。人物侧写/扮演、正式采用和新独立 UI 不在本版范围。

## Agent 监控（2026-11-11）

只读 overview 额外返回 monitoring：按角色聚合、最近300次请求趋势及遗漏数量。旧字段保持兼容。模型流新增本地数字计量，记录输入语句分类字符数、输出字符分类、首Token和流阶段耗时，不保存原文。输入Token含缓存一次；字符占比不能当作计费Token。旧记录不补造阶段数据，工具执行耗时尚不在模型流计时内。Dashboard可独立关闭，计量不依赖其UI，也不改变原额度。
