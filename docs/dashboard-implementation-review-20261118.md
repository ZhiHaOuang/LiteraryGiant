# Dashboard 实现审查 · 2026-11-18

**结论。** 当前 Dashboard 可以在现有包内完成精简。优先处理两类已证实的维护负担：生产入口走不到的代码，以及计算或保存后没有消费者的结果。局部存在过度保护，主要位于已经取得有效响应的视图内部。外部数据进入 Dashboard 时的校验有独立职责。

## 审查基线

对象是 DSH 的 `dsh-plugins/lg-dashboard`。本轮检查包入口、构建可达性、视图的调用者、请求和状态生命周期、统计计算、样式挂载及测试。相邻插件只用于核对契约。结论针对本机工作树：父仓库 `codex/polish-compliance-20261022`，HEAD `7e23cf4`，LiteraryAgent 子模块 `07893dca`；Dashboard 目录在父仓库中尚未跟踪。审查使用合成数据。

| 实测对象 | 结果 |
|---|---|
| 源码 | 包内普通非隐藏文件 112 个。src 有 70 个文件，其中 43 个 JS/JSX/TSX 共 2,511 行，8 个 CSS 共 867 行 |
| 构建 | 按仓内 esbuild 配置在内存中重建。509 个依赖图输入中有 59 个来自本包 src。输出与磁盘 client.js 逐字节相同，SHA-256 为 `e4ab960c9944d8653e0d64e3ca9b8478a3c39509ca465d8e33d34ba285e28773` |
| 对外边界 | 3 个宿主插槽、1 个含 2 个方法的导航服务、1 条 Dashboard 自有 HTTP 路由、2 个声明的 peer 依赖。下列清理均可在这些边界内进行 |

调用链很短。宿主载入 client factory，由 `apply` 注册插槽及 `openGlobal/openBook`。主插槽挂载 `DashboardRoot`，根据当前导航打开全局或单书视图。故事资料经 `requestStory → requestBooks` 读取，统计分别消费 Context 快照和 Teams 账本。插件服务端入口单独提供供应商目录。统计代码从固定的兄弟包 dsh-context 导入聚合、价格和图标实现，属于构建期源码耦合。此次精简可以沿现有模块完成，无须另造一层统一转发。[宿主注册](../dsh-plugins/lg-dashboard/src/client.jsx#L161) · [服务端路由](../dsh-plugins/lg-dashboard/index.js#L1) · [Context 聚合](../dsh-plugins/lg-dashboard/src/context-data.js#L1) · [构建与外部依赖](../dsh-plugins/scripts/build.mjs#L25)

## P0

在本次审查的冗余、过度保护与实现复杂度范围内，未发现需要紧急重构的 P0。

## P1 · 可以独立验收的清理

| 问题与代码证据 | 最小改动及收益 | 风险、验证与置信度 |
|---|---|---|
| **两份旧组件没有生产入口。** `CreateBook` 和 `TeamRequests` 均未进入实测依赖图，反查也没有源码调用者，包清单未导出这两个子路径。同一轮还找到 `bookshelf.jsx` 中只有定义的 `BookWorkspace`。[CreateBook](../dsh-plugins/lg-dashboard/src/create-book.jsx#L3) · [TeamRequests](../dsh-plugins/lg-dashboard/src/team-requests.jsx#L4) · [BookWorkspace](../dsh-plugins/lg-dashboard/src/bookshelf.jsx#L68) · [包导出](../dsh-plugins/lg-dashboard/package.json#L6) | 两份完整文件列入待批准删除范围，源码减少 2 个文件、58 行。另可单独移除 `BookWorkspace` 函数。前两份文件原本就未打包，删除它们的收益是减少维护面。 | 独立比较删前、删后生产包；仅删两份不可达文件时应逐字节一致。删除 BookWorkspace 前复核外部脚本的深路径导入，关联样式逐选择器核对。**高** |
| **单书导航保留了一条写完就失效的状态链。** 单书读取成功后调用 `rememberBook(next)`，闭包写入 `lastBook`。唯一读出处把它作为 `initialBook` 传给 `DashboardRoot`，而 Root 从未读取这个参数；真正传入子视图的是 `view.path`。[读取成功回调](../dsh-plugins/lg-dashboard/src/client.jsx#L66) · [Root](../dsh-plugins/lg-dashboard/src/client.jsx#L144) · [注册闭包](../dsh-plugins/lg-dashboard/src/client.jsx#L165) | 移除一个闭包变量、一条跨两层的回调和 Root 的无用参数。单书 `Dashboard` 自身消费的 `initialBook` 继续保留。 | 外部服务可以在主面板挂载前发起导航，`navigation.target` 因而有用。回归首次挂载前打开书、书架内切换书、带章节跳转和返回书架。**高** |
| **时间图为一个桶计算四个角色，再只取第一项。** `timelinePairs` 给桶合计临时指定 `coordinator`，调用按四个角色展开的函数后取 `[0]`。Tokens 模式还先执行一次 `usageBars`，整个结果都被丢弃。详情区在非 Tokens 模式也提前构造仅 Tokens 使用的 `detailPair`。[时间桶](../dsh-plugins/lg-dashboard/src/components/time-stacks.js#L9) · [四角色展开](../dsh-plugins/lg-dashboard/src/team-data.js#L34) · [详情消费](../dsh-plugins/lg-dashboard/src/team-usage.jsx#L37) | 第一批仅让计算在消费它的模式中运行。第二批可把现有单行转换从角色循环中提出，桶合计直接转换一行，环图继续对四个角色调用。详情标题仍然消费 `detail.value`。 | 内存对照仅移动 Tokens 模式的无用计算，4 种模式 × 5 个角色范围 × 3 种桶数据，60 个桶输出深度相等。提取单行转换仍需另验颜色、分项、顺序、真实零值和未知值。**高** |
| **同一张柱图有两套水平布局。** `agentStacks` 计算每列的 left、width 和整体 barWidth。唯一生产调用者紧接着用另一套公式覆盖三者，并为每列复制对象。现有几何单测直接调用前一套公式。[基础布局](../dsh-plugins/lg-dashboard/src/components/agent-stacks.js#L5) · [覆盖位置](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L62) · [几何测试](../dsh-plugins/lg-dashboard/tests/agent-stacks.test.mjs#L17) | 将当前真正用于渲染的水平公式移入现有布局函数，保留垂直比例和筛选逻辑。消除一套公式和一次逐列复制，单测直接覆盖实际使用的几何值。 | 对多种宽度、1 桶和多桶比较每列 left、width、height 及选中位置。以当前渲染输出作为基线。**高** |

## P2 · 局部状态、保护与重复计算

| 问题与代码证据 | 最小改动及收益 | 风险、验证与置信度 |
|---|---|---|
| **时间视图同时支持两种所有权，当前入口只使用父组件提供值的路径。** 两处生产挂载都传 `throughChapter`；人物模式来自已选择的人物并传 `person.id`。子组件仍维护 `localThrough`、`subject`，支持两个独立选择器，还在切换候选开关时写回原人物。[两个调用点](../dsh-plugins/lg-dashboard/src/story-data.jsx#L20) · [情节入口](../dsh-plugins/lg-dashboard/src/story-data.jsx#L36) · [子组件](../dsh-plugins/lg-dashboard/src/temporal-view.jsx#L51) | 使用上层已持有的章节范围和人物 ID，移除这两份本地状态以及仅服务于内部选择器的分支。参照事件、前后时点、候选开关仍由子组件持有。 | 比较三种模式发出的 `story-time.options`；切换候选仍须清空参照事件。人物选择器判断以当前有效作品 ID 为前提。[ID 契约](../dsh-plugins/lg-books/src/story-data/contract-v1.json#L481) **高** |
| **响应通过校验后，视图又为必有字段提供缺省。** `story-data` 校验保证 offset 是非负整数，成功回调仍读 `value.offset ?? 0`。`story-overview` 保证 coverage 和 quality 的结构，唯一调用路径上的 `StoryQuality` 仍逐一判空。[边界校验](../dsh-plugins/lg-dashboard/src/story-read.js#L18) · [分页消费](../dsh-plugins/lg-dashboard/src/story-browser.jsx#L25) · [传入概览](../dsh-plugins/lg-dashboard/src/story-data.jsx#L66) · [质量视图](../dsh-plugins/lg-dashboard/src/story-quality.jsx#L2) | 成功后的 offset 直接使用。质量视图只需处理初始或失败时的 `data === null`。减少两处可能误导维护者的数据形态。 | 用缺 offset、缺 quality 的无效响应验证边界仍拒绝；用首次加载、合法空结果、翻页验证视图。稀疏的分类计数和确实可空的字段仍须兜底。**高** |
| **固定日期范围也扫描全部历史。** `statisticsRange` 对每行日期展开、过滤并排序，只有 `all` 会取排序结果。同一区间的日期还在父视图、`deriveUsage`、API 卡各自展开。[范围计算](../dsh-plugins/lg-dashboard/src/stat-period.js#L3) · [父视图](../dsh-plugins/lg-dashboard/src/global.jsx#L78) · [聚合](../dsh-plugins/lg-dashboard/src/context-data.js#L9) · [API 卡](../dsh-plugins/lg-dashboard/src/api-panel.jsx#L22) | 先将历史读取移到 `all` 分支，单次遍历求最早有效键。之后可由已有聚合结果携带日期列表及有效性，选定范围的卡片复用。固定七天图有独立口径。 | 参考实现与现实现对照 56 组输入，返回值相同。在 4 行合成历史上依次调用五个固定预设，历史 days 属性读取由 20 次降至 0 次。联网、页面延迟及多卡共享方案未计入此实验。**首项高；共享范围中等** |
| **一组五张图挂载六份同样的 CSS。** 父组件和每个子图都渲染 `<style>`。React 静态渲染合成时间线得到 5 张图、6 个 style 节点，文本逐份相同，每份 14,860 字节。[组容器](../dsh-plugins/lg-dashboard/src/components/AgentTimelines.jsx#L9) · [图表内部](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L93) | 在现有组容器注入一次，5 张图共享，DOM 减去 5 个重复样式节点。每张图用于测量自身宽度的 ResizeObserver 仍有独立输入。 | 这是 DOM 注入次数。实施后检查相邻规则的层叠顺序、计算样式及测试夹具的挂载入口。**高** |

## P3 · 顺手处理的维护点

- 未使用符号检查确认 `global.jsx` 的 `windowFor` 导入和 `onManage` 参数、`team-panel.jsx` 的 `number` 导入、`team-usage.jsx` 的 `roleNames` 导入和未使用的 `label` 解构、`StackedBars.tsx` 的局部类型 `Pair`。在触及相应模块时清理即可。检查使用 TypeScript 的未使用符号诊断，未据此认定整个包通过类型检查。风险低，编译和重跑对应测试即可。**高**。[全局视图](../dsh-plugins/lg-dashboard/src/global.jsx#L12) · [团队视图](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L2) · [用量视图](../dsh-plugins/lg-dashboard/src/team-usage.jsx#L5) · [图表类型](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L28)
- `StackedBars` 在已满足 `column.value === null` 的分支里又执行同一判断，第二个结果 `'0'` 不可达。仅将该节点内容化简为未知值符号；用未知和已知零值两种列核对输出。**高**。[渲染分支](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L108)

## 应保留的实现

- `requestBooks` 检查 HTTP 与响应信封，`validateStoryResponse` 检查动作对应的数据形态，`shouldRestartStoryPage` 检查跨页期间作品与版本是否变化。一次成功请求可以通过前两层，仍触发第三层。三者处理不同失败条件。[传输](../dsh-plugins/lg-dashboard/src/api.js#L1) · [版本判断](../dsh-plugins/lg-dashboard/src/story-read.js#L14) · [分页测试](../dsh-plugins/lg-dashboard/tests/story-read.test.mjs#L15)
- `pollOverview` 的 pending 合并手动刷新与尚未完成的读操作，disposed 状态阻止不可取消的快照读取在卸载后回写。Teams 请求支持 AbortSignal，404 还有可选服务未安装的语义。保留各自的生命周期处理较清楚。[Context 轮询](../dsh-plugins/lg-dashboard/src/api.js#L11) · [Teams 请求](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L16) · [轮询测试](../dsh-plugins/lg-dashboard/tests/loading.test.mjs)
- 未进入构建图的另外 9 个 src 文件含原始图表示例、候选素材和出处说明。已有明确的留存用途，不能仅凭构建可达性认定为死代码。[原始示例留存记录](handoff.md#L115) · [素材说明](../dsh-plugins/lg-dashboard/src/assets/companions.md) · [许可说明](../dsh-plugins/lg-dashboard/NOTICE)

## 实施顺序与验收

1. **先固定回归基线。** LitIsLand 隔离副本与项目的 70 个 src 文件、28 个测试相关文件逐文件一致；包内 Node 测试本次 44/44 通过。另行复跑两个跨包文件，其中两项失败：注册测试的 React 替身缺少 createContext；对白测试要求 active 恰有 30 条，当前为 0。先为注册测试提供实际依赖，把对白机制断言与会变化的作者素材分开，再用这些测试保护清理。此次没有重跑整个桌面 E2E 或工作区全套测试。[注册夹具](../dsh-plugins/tests/client.test.mjs#L12) · [对白夹具](../dsh-plugins/tests/dashboard-home.test.mjs#L15)
2. **清理不可达代码和无效状态传递。** 两份独立文件先按具体范围取得删除授权。单计这两份，源码文件从 43 个降到 41 个，减少 58 行。导航回调单独处理，验收三种进入单书的路径。故事视图内的重复兜底与本地选择状态另作小改。
3. **收敛统计和图表内部计算。** 固定日期预设、时间桶计算、柱布局和样式挂载各自单独验收。分别比较返回值、桶与分项、最终几何、样式节点和计算样式。以上目标新增包、运行依赖及对外接口均为 0；没有实测的交互耗时收益不列作验收结论。

本轮交付是代码审查记录。所有对照均在内存或已有隔离副本完成，产品源码、生成包和作品数据未被本轮修改。
