# LiteraryGiant Dashboard 架构审查

2026-11-18 · 第一阶段 · 供作者决定实施范围

## Dashboard 模块专项复核

**建议第一批只验证两条界面规则：打开谁的档案，就显示谁持有的认知；选了哪本书，就只显示那本书的任务。** 前者在这次完整客户端实验中复现，后者在前次隔离组件实验中复现。它们直接影响作者理解人物和审阅候选。两者可以独立修复和验收。

### 在实际客户端复现的行为

在隔离的 Electron 窗口加载当前发布入口 `lg-dashboard/client.js`。使用真实 React 和 Books 读模型，作品由合成 SQLite 夹具生成；插槽、图标、HTTP 传输和 Teams 响应使用测试替身，以便控制时序。以下结果来自点击和读取渲染后的 DOM。没有连接日常 Beta 或发起模型请求。

| 优先级与入口 | 可复现的操作与结果 | 最小改法与回归标准 |
|---|---|---|
| **P1 · 人物 → 人物认知** | 在合成书中添加一条持有人为林澈、普通关联指向阿远的信念。打开阿远的“人物认知”，面包屑是阿远，列表中出现“只有林澈持有的信念”。页签传的是通用 `subject`，它同时匹配持有人、普通链接及范围引用。**这是作者界面归类错误**；实验没有运行角色 Agent。[页签查询](../dsh-plugins/lg-dashboard/src/story-data.jsx#L21) · [查询条件](../dsh-plugins/lg-books/src/story-data/store.js#L147) · [哪些字段被视作引用](../dsh-plugins/lg-books/src/story-data/validate.js#L34) | 给“人物认知”使用精确的 `payload.holder` 筛选语义，在服务分页与计数之前生效。沿用作者视图以保留候选和误解。验收同一条记录出现在林澈的认知页、不会计入阿远的认知页；普通关联仍能从原记录查看。切勿只过滤 UI 已收到的一页。 |
| **P1 · 书架 → 需要你处理** | 延迟读取一本确有候选的书，待审卡先显示“0 章待审／暂无待审正文”，请求完成后变成“1 章待审”。另登记两本书并让第二本读取失败，页面有“汇总不完整”警告，但“书籍数量／已登记作品”显示 1。组件用成功返回的 `books` 同时代表登记集合与已读集合。[逐书汇总](../dsh-plugins/lg-dashboard/src/global.jsx#L53) · [书数](../dsh-plugins/lg-dashboard/src/global.jsx#L98) · [待审卡](../dsh-plugins/lg-dashboard/src/global.jsx#L146) | 使用已有的书架清单、加载状态、成功结果和失败列表，分别显示登记数和读取进度。只在所选范围完整读取后宣告“暂无”；部分失败时仍可打开已知候选。验收慢读、有一书失败、真实零候选三种状态，新增请求数应为 0。 |
| **P1 · 文学 Agent → 任务详情** | 展开运行中的任务，详情显示“等待成员提交”。让同一任务完成并返回新产物，点击书架刷新，任务标题变成“候选已完成”。折叠重开后详情仍显示等待，整个操作对 `task` 只发出 1 次读取。与前次静态发现一致。[首次展开条件](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L21) · [列表以任务 ID 复用组件](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L61) | 以任务 ID 和更新时间识别详情版本，刷新时只重读已展开且需要更新的任务；重新展开时核对来源。验收同一 ID 的状态、候选正文和来源一致，折叠的其他任务不提前加载。 |
| **P2 · 人物列表 → 档案 → 返回；情节 → 刷新** | 搜索 8 位“样例人物”，按名称排序，翻到第 2 页打开档案。返回后搜索框为空、排序重置、页码为“1 / 2 · 10 条”。另在“章节梗概”点击刷新，当前栏目切回“具体情节”。两处都将组件重新挂载与重新取数绑定在一起。[列表本地状态](../dsh-plugins/lg-dashboard/src/story-browser.jsx#L7) · [详情及刷新键](../dsh-plugins/lg-dashboard/src/story-data.jsx#L79) | 只把查询、排序、页码和当前子页签放到能跨该次导航存活的位置；保留已有数据修订变化时回第一页的机制。相同版本、相同阅读范围内，返回应恢复“2 / 2 · 8 条”，刷新梗概仍停在梗概。无需跨书缓存正文。 |

### 对插件本身的取舍

- **书架首先回答“我在哪本书接着工作”。** 当前 Agent 名单和统计排在作品进度、待审入口之前。若要让 Dashboard 优先服务作者，最小调整是移动已有的“作品进度”和“需要你处理”，使它们优先于运行统计。保留图表、Beta 样例和角色装饰。此项是产品排序建议，尚无作者使用时长或点击率测量。[全局页面的实际排列](../dsh-plugins/lg-dashboard/src/global.jsx#L124)
- **单书页保留人物、情节、环境三栏。** 已有栏目能承载不同的文学问题。此次实验支持优化字段归属、阅读范围和返回路径，未发现需要为三个栏目分别创建插件或共享全局 store 的依据。[栏目信息](../dsh-plugins/lg-dashboard/src/story-sections-data.js#L1)
- **第一批拆成两个可验收的小改动。** 先加“持有人与被关联人不同”的回归并修人物页，再修跨书任务响应，已有待审和详情的实验可供下一批使用。作者确认方向后再调整卡片顺序、删除旧组件或处理资源体积。

本次隔离运行的 Dashboard 自有单测为 **44/44 通过**，上述 Electron 交互的页面脚本错误为 **0**。这些问题表现为渲染出了不合适的数据或状态，常规成功响应和无脚本异常都不足以检出。实验验证了本地发布包在受控宿主中的行为，完整 DSH 桌面联调仍是修改后的验收项。

## 前次架构审查

**建议保留一个 DSH Dashboard 插件、现有两级页面和文学服务边界。第一批值得修的是查询作用域。** 在本轮合成实验中，切换到作品 B 后仍能看到 A 的候选任务，B 加载失败后它也继续留在页面。另一个直接影响作者阅读的例子是，选择“截至第 1 章”能得到当时的人物资料，展开修订历史却会带出后章摘要。两处都有小范围修复办法，无需重写 UI、改 AgentLoop 或迁移作品。

另有一项需要作者决定。Beta 的团队统计按先前要求固定叠加月度样本。空账本在近 7 天视图可显示 84 次请求、509,470 Tokens。此卡当前适合调试图形，不能用来衡量团队实际调用量或判断文学效果。账本和费用结算没有因此增加。保留 Beta 的演示能力与恢复真实用量的可辨识性可以同时实现。[叠加实现](../dsh-plugins/lg-dashboard/src/team-usage.jsx#L33) · [原决定](handoff.md#L63)

## 一、审查对象与证据边界

以当前工作树为准。父仓库分支为 `codex/polish-compliance-20261022`，HEAD 为 `7e23cf4`，`LiteraryAgent` 子模块记录为 `07893dca`，工作树已有修改。Git 当前把 `dsh-plugins/lg-dashboard/` 列为未跟踪目录，所以单靠父仓库提交不能重建本次受审版本。当前 desktop profile 的 `node_modules/lg-dashboard` 是指向该工作树的符号链接。用仓内构建参数在内存中重建，与该路径下的 `client.js` 逐字节一致，SHA-256 为 `e4ab960c9944d8653e0d64e3ca9b8478a3c39509ca465d8e33d34ba285e28773`。这能定位磁盘产物，已打开窗口可能仍在使用先前加载的脚本。

覆盖包入口、全部源码和资源的构建可达性、样式注入、语言包、打包清单、插件内测试及相邻包的消费者；沿调用链进一步检查 Books、Workbench、Agent Teams、Brand、DSH Context 和 VS Code 的真实入口。生成包通过依赖图、哈希和注册实验检查。项目已有两个不同的 UI 宿主，本报告对 VS Code 追踪至其书籍 RPC 和视图更新，未将整套独立编辑器或其 Runtime 列入 Dashboard 的删除范围。本轮使用合成作品和临时账本，未读取真实小说或调用模型。

### 当前规模与可以验证的目标

| 对象 | 实测基线 | 建议目标与口径 |
|---|---:|---|
| 插件目录普通文件 | 112，排除隐藏文件，含产物、测试、许可 | 首批若批准删除两个未挂载组件，净减少 2 个旧文件。新回归用例按需要保留 |
| `src/` | 70 个文件，其中 43 个 JS/JSX/TSX 共 2,511 行，8 个 CSS 共 867 行，14 张 PNG | 两个旧组件合计 58 行，单计此项为 41 个代码文件、2,453 行。源文件数与运行成本分别衡量 |
| 生产入口依赖图 | esbuild 解析 509 个输入，含传递依赖和虚拟价格模块。70 个本包 src 文件有 59 个进入输入图 | 保留一个 Web 入口。未进入图的 11 个文件分别有旧实现、作者素材和出处文档，不能一批删除 |
| 客户端与发布包 | `client.js` 17,734,317 字节。当前树离线 pack 预检为 14 个文件，压缩后 11,806,976 字节 | 正式包以字节、冷加载与截图衡量。两个未挂载组件的删除对当前 bundle 收益为零 |
| 接口 | 3 个 UI 插槽、1 个含 2 个方法的导航服务、1 条插件自有 HTTP 路由。UI 涉及 4 条 HTTP 路由，Books 在当前界面有 11 个动作，Teams 有 2 个 | 首批目标保持这些入口和动作数。只有形成更小的整体读取成本时才考虑增加摘要投影 |
| 依赖 | 包声明 2 个 peer、2 个宿主 Client 注入；实际 bundle 需宿主提供 React、React JSX runtime、DSH UI primitives。工作区共用 8 个 devDependencies、1 个 dependency、1 个 peer | 首批新增依赖 0。工作区依赖须连同其他插件核对，不能按 Dashboard 单独删 |
| 测试 | 包内 28 个测试相关文件，15 份 Node 测试文件；9 个名称含 desktop 的脚本，其中 2 个转调同一个新版脚本 | 保留有消费者的命令和视觉夹具，按实际覆盖场景统计，先校正两个已失败的断言或夹具 |

计数使用文件实际换行。包目录行数不与生成包、图片或测试混算。构建使用 esbuild、浏览器 ES2022、CJS factory、CSS 文本和 PNG data URL。React 由宿主提供，Motion 被打进 bundle。包内没有单独的 TypeScript 类型检查命令；esbuild 成功只证明转译和模块解析通过。[包清单](../dsh-plugins/lg-dashboard/package.json) · [工作区依赖与测试脚本](../dsh-plugins/package.json) · [构建入口](../dsh-plugins/scripts/build.mjs#L9)

## 二、实际调用链和模块所有权

| 作者操作 | UI → 服务 → 结果 | 状态、错误和写入归属 |
|---|---|---|
| 打开书架、选创作目录 | DSH 装载 client factory → `apply` 注册 onboarding、main 和 sidebar → `useShelf` → `shelf`；选择目录经 `uiWorkspace.pickDirectory` → `configure-directories` → Books 配置与 workspace 注册 → 新书架 | 目录选择写配置，书架同步会登记 workspace。React 保存加载状态。目录无效、部分作品不可读和书架确实为空有不同含义。[UI](../dsh-plugins/lg-dashboard/src/bookshelf.jsx#L7) · [注册](../dsh-plugins/lg-dashboard/src/client.jsx#L161) · [Books](../dsh-plugins/lg-books/index.js#L69) |
| 全局概览、单书、章节 | Global 逐书执行 `read` → `snapshot` → SQLite 中的有效版本、场景归并与待审计数 → 作品表和待办；点击章节切换到 Dashboard。workspace 菜单则由 Brand 调用 `literaryDashboard.openBook` | Books 管正文、字数定义和正式版本。全局搜索排序、单书分页、定位与展开留在视图。[Global](../dsh-plugins/lg-dashboard/src/global.jsx#L53) · [归并](../dsh-plugins/lg-books/src/summary.js#L8) · [Brand](../dsh-plugins/lg-brand/src/client.js#L18) |
| 查看人物、情节、环境 | StorySections → `story-overview`；StoryBrowser、TemporalView → `story-data`、`story-time` → 版本化读取封套 → 人物、事件、状态、读者揭示及引文。StoryRecord 按需调用旧的 `story-data-history` | 正式记录、候选、有效范围、修订和来源由 Books 计算。Dashboard 负责筛选条件、分页游标和展示。磁盘导出快照另有读者，当前 UI 主要走路由。[分区](../dsh-plugins/lg-dashboard/src/story-data.jsx#L14) · [客户端契约](../dsh-plugins/lg-dashboard/src/story-read.js#L14) · [Books 读模型](../dsh-plugins/lg-books/src/story-data/read-model.js#L12) |
| 审阅候选、监督、索引 | 展开章节 → `pending-versions` → `literaryWorkbench.openVersion(path, document, version)`。候选预览及采用由 Workbench 调 Books。Dashboard 自身另有启用监督、预览索引、按 token 重建索引的按钮 | 保留具体版本、作者操作、注册作品校验和重建备份。删除未挂载的表单不会授权删除这些路径。[候选](../dsh-plugins/lg-dashboard/src/pending-versions.jsx#L10) · [编辑台](../dsh-plugins/lg-workbench/src/client.jsx#L71) · [采用预览](../dsh-plugins/lg-workbench/src/api.js#L10) · [索引保存](../dsh-plugins/lg-books/src/story-index.js#L77) |
| 看会话、模型与成本 | DSH 插槽传入 sessions/workspaces 快照，Global 轮询 Context 的 `snapshot`，按 workspace 路径归书；按本地价格表估算费用。服务商目录走 Dashboard 唯一的 Host 路由，仅读取 id/name；会话跳转交回宿主 | 当前账单、估算和未知值各自处理。Context 失败不应妨碍作者打开单书。Provider 列表为空与服务暂不可用有单独测试。[聚合](../dsh-plugins/lg-dashboard/src/context-data.js#L1) · [Context 请求](../dsh-plugins/dsh-context/src/client/overview.ts#L900) · [Host](../dsh-plugins/lg-dashboard/index.js#L3) |
| 看文学 Agent 任务 | TeamPanels → `/api/lg/teams` 的 `overview` → Teams SQLite 账本和角色目录；展开某任务才请求 `task` → 计算当时的来源有效性 → 展示候选、来源和指标 | Dashboard 没有调度成员、调用模型或批准正文的职责。404 表示可选插件未启用。Teams 的真实请求记录和 Context 的会话汇总有不同粒度。[面板](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L16) · [路由](../dsh-plugins/lg-agent-teams/index.js#L179) · [账本](../dsh-plugins/lg-agent-teams/src/store.js#L107) |

这里的 4 条 HTTP 路由是 `api/lg/books`、`api/lg/teams`、`api/dsh-context/snapshot`、`api/lg/dashboard/providers`。Books 的 11 个动作是 `shelf`、`configure-directories`、`read`、`pending-versions`、`enable-supervision`、`story-data`、`story-time`、`story-overview`、`story-data-history`、`story-index` 和 `story-index-save`。已断开 UI 的 `create-preview`、`create` 没有计入。

**独立的 VS Code 路径。** `activate` 注册 `literarygiant.chat` → DesktopHost 启动 DesktopClient 处理作品及 CLI 配置 → Webview 用 `postMessage` 交互 → LiteraryBackend 经标准输入输出 JSON-RPC 调用 Python `lg_cli.backend_stdio`。其中 `book/dashboard` 返回后发出 `book.updated`，SessionStore 更新书籍，LatestSnapshotSender 合并待发送的全量快照。Native/Codex 是该后端的执行器选项，mock 有测试入口限制。日常 DSH Dashboard 的刷新不经过这条链。两个宿主有各自的安装入口、协议和调用者；本轮的证据不足以支持删除 VS Code、Python CLI、Native 或 Codex。[激活](../LiteraryAgent/lg-vscode/src/extension.ts#L8) · [Host](../LiteraryAgent/lg-vscode/src/host/DesktopHost.ts#L41) · [RPC](../LiteraryAgent/lg-vscode/src/backend/LiteraryBackend.ts#L40) · [书籍更新](../LiteraryAgent/lg-vscode/src/backend/LiteraryBackend.ts#L230) · [Python 分发](../LiteraryAgent/lg-cli/lg_cli/backend.py#L678)

## 三、按优先级排列的发现

P0 用于已能在正常交互中展示错误作品数据的问题。P1 包括已复现的契约问题、失效测试和可确认的重复工作。P2、P3 按维护价值安排。以下每项的置信度分别针对当前行为；尚待验证的影响另列。

### P0-1　作品或区间切换后，团队面板沿用前一查询的候选和统计

`GlobalDashboard` 在筛选改变时把新条件交给 TeamPanels。其 effect 中止旧请求，但旧 `data`、`ready` 还在；新请求失败仅更新 `error`。任务列表继续从旧 `data.tasks` 渲染。“以下为上次结果”没有给出那次结果所属的书。隔离 React 实验挂载真实 TeamPanels，让 A 成功、B 等待、B 拒绝，三步都能找到 A 的独有任务，最后一步还同时显示 B 的错误。实验替代了网络和无关图形子组件。[条件入口](../dsh-plugins/lg-dashboard/src/global.jsx#L125) · [加载与渲染](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L35)

**改法与验收。** 将一个响应与产生它的查询条件绑定，渲染前对照当前作品和周期；同范围刷新可以显示注明时间的旧值，跨范围立刻进入加载或错误态。这样能取消“data 来自哪里由多个布尔值推断”的做法，无需引入全局状态库。覆盖 A→B→A、请求逆序、B 失败、卸载、404、同范围刷新，检查任务和指标两处。收益是跨范围旧值展示从可复现变为 0。置信度高。

### P1-1　人物和事件的正文范围在“修订历史”按钮处中断

主查询用 `through_chapter` 沿修订链选出当时的记录；卡片的历史请求只有 path 和 id，Host 返回整条修订链，卡片逐条显示摘要。合成书中为同一人物增加后章修订后，“截至第 1 章”列表没有后章文字，历史数组却有，UI 会显示该字段。文档将旧接口定义为按稳定 ID 查询全历史，所以作者的“全书审计”确有消费者。问题在于受限阅读视图没有表达这次范围切换。[列表](../dsh-plugins/lg-dashboard/src/story-browser.jsx#L18) · [历史按钮](../dsh-plugins/lg-dashboard/src/story-record.jsx#L32) · [范围选版与历史查询](../dsh-plugins/lg-books/src/story-data/store.js#L124) · [旧接口约定](story-dashboard-data.md#L71)

**改法与验收。** 保留默认全历史，给现有动作增加可选阅读范围，让 Books 根据证据选修订；作者主动查看全书历史时清楚标出范围。无须新增路由，也不应把已传到前端的后章内容仅用 CSS 隐藏。验证后章修订、跨多章引证、候选和确认并存、无修订及旧调用。这里验证的是作者页面的范围一致性，未发现正式数据被改写，亦未据此推断角色 Agent 获得了信息。置信度高。

### P1-2　任务摘要在更新，已打开的详情停留在第一次读取

`Result` 以 task.id 为 React key，首次展开后有值就不再查询。服务端恰恰是在 `task` 请求时计算 `source_current`。同一任务从运行进入完成时，标题可已变成“候选已完成”，详情仍显示“等待成员提交”。即使任务状态不变，来源正文也可能更新。[详情缓存](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L21) · [任务更新时间](../dsh-plugins/lg-agent-teams/src/store.js#L122) · [来源核对](../dsh-plugins/lg-agent-teams/index.js#L185)

**改法与验收。** 保留按需取详情。展开时重验来源，已展开的任务在 `updated_at` 变化或用户刷新时更新，丢弃过期响应。一般轮询不拉所有候选正文。对同一 id 演练运行→完成、修改来源后重开、失败后恢复。无需新增动作。置信度高，桌面端时序待回归。

### P1-3　全局浏览和单书概览重复扫描，成本落在文学主路径上

- 全局页串行对每本书发一次完整 `read`。目录发现的书通常逐本经过 `registered → shelf.list → scanShelf → describeBook`；目录内有 N 本有效作品时，仅这段登记核对就可能累计约 N² 次逐书检查。随后每本书又读有效版本内容、进行字数归并并计算含正文的指纹。传给浏览器的是摘要，重活发生在 Host。书架同步内部也会为 workspace 注册和返回值多次扫描。[全局循环](../dsh-plugins/lg-dashboard/src/global.jsx#L56) · [登记核对](../dsh-plugins/lg-books/index.js#L30) · [目录同步](../dsh-plugins/lg-books/src/bookshelf.js#L46) · [正文指纹](../dsh-plugins/lg-books/src/read.js#L47)
- 单书 `story-overview` 调完整导出用的 `collectStoryView(...).overview`。overview 和 timeline 各自通过 `envelope` 重算同一事务的版本，每次读取所有活动正文计算摘要；还会构造仅导出才消费的 sections。15 条合成记录的一次真实 overview 调用，通过查询计数观测到 **2 次**用于版本计算的全文查询。快照导出和时间质量检查仍然需要相应数据。[事务](../dsh-plugins/lg-books/src/read.js#L28) · [组装](../dsh-plugins/lg-books/src/story-data/read-model.js#L6) · [导出消费者](../dsh-plugins/lg-books/src/story-data/snapshot.js#L22)

**改法与验收。** 先在同一读事务内复用一次 revision，目标 2→1，按现有快照逐字段比较。随后把概览所需的事实与仅供导出的封装分开。书架在一次同步内复用一次目录发现；若独立压测仍显示跨书开销显著，再由 Books 提供整架摘要，一次验证登记范围，返回统计、待审章定位和逐书错误。保持单书 `read` 对外兼容、场景归并字数、损坏作品提示以及写操作独立校验。用 1、10、50 本合成书记录请求、目录扫描、DB 打开、耗时分位与返回字节。本轮未测真实书架时延。置信度高，实际提速待测。

### P1-4　当前回归基线有两个独立失败

1. 工作区的书架用例硬编码旧素材 `active.length === 30`。正式播放清单已使用 `conversations`，`active` 为空；同文件的书架点击用例仍通过。按交接，更新对白是作者决定。将旧格式兼容测试放在合成输入上，用实际播放入口验证现行分组、非空和角色绑定，保留作者对白。[旧断言](../dsh-plugins/tests/dashboard-home.test.mjs#L15) · [播放器](../dsh-plugins/lg-dashboard/src/team-roster.jsx#L41) · [素材变更记录](handoff.md#L51)
2. 单独运行客户端注册用例，Dashboard 在 `createContext is not a function` 处失败。替身只实现了 `createElement`，且其 VM 缺少 Motion 用到的浏览器基本能力。换用真实 React 18.3.1、JSX runtime、微任务调度和最小宿主替身，实际项目 bundle 成功注册 3 个插槽和 2 个导航方法。应更新测试宿主或复用已有客户端测试设施，保留对插槽和依赖边界的断言。[注册测试](../dsh-plugins/tests/client.test.mjs#L9) · [DSH 宿主提供的模块](../dsh/packages/client/web/src/seed.ts#L32)

目标是两个已知假失败归零，再重跑默认测试入口；不能只删断言或用新测试替代旧行为覆盖。置信度高。

### P1-5　两处产品 UI 文件没有挂载，构建包中也没有它们

`CreateBook` 封装创建预览与确认；`TeamRequests` 展示逐请求明细。两者都未从生产入口进入 esbuild 图，包 exports 未导出源码，目录内外的源码反查也未找到组件调用。当前界面的“任务与候选”由 TeamPanels 自行渲染。另有无调用的 `BookWorkspace` 导出及 `windowFor`，后者仅剩未用 import。[旧建书表单](../dsh-plugins/lg-dashboard/src/create-book.jsx#L3) · [旧明细](../dsh-plugins/lg-dashboard/src/team-requests.jsx#L4) · [旧导航组件](../dsh-plugins/lg-dashboard/src/bookshelf.jsx#L68) · [日期函数](../dsh-plugins/lg-dashboard/src/global-data.js#L24)

**改法与验收。** 可申请删除上述两个整文件，单独清理两个未用符号和确属专用的 CSS。建书服务、审计记录与外部脚本另有边界；这份证据仅支持清理 UI。若“从书架新建作品”仍是需求，应单列恢复入口，直接保留一份未挂载的表单无法交付它。目标净去除 2 个旧文件、58 行组件。以生产构建、发布清单、外部 import 和书架/候选回归验证。两个文件的生产不可达置信度高，仓外直接私有导入未知。

### P1-6　图表容量和服务端协议不完全一致

总图的 ResizeObserver 将测量宽度换算成容量，再经 TeamPanels 请求后台。前端范围为 1–96，服务端只收 2–96。调用实际函数，宽度 1 → 容量 1 → `Invalid Agent bucket count`，宽度 24 和 390 则通过。本地绘图允许合为 1 柱是合理行为；一个布局值跨越服务协议才产生问题。[宽度换算](../dsh-plugins/lg-dashboard/src/components/time-stacks.js#L6) · [上报](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L40) · [服务约束](../dsh-plugins/lg-agent-teams/src/usage-timeline.js#L13)

**改法与验收。** 在对外请求处满足已有范围，保留本地单柱绘图；隐藏或尚未测得宽度时沿用有效请求。覆盖隐藏→显示、最窄宽度、多次 resize、桶总量守恒。两个函数的失配已实测，作者能否在常用宽度观察到该错误待实机确认。置信度高。

### P2　规模、依赖与产品方向

| 事项与代码依据 | 建议、收益、风险和验证 |
|---|---|
| **正式统计与样例共享同一渲染输入。** `TeamUsage` 在有 v1 timeline 且非 unbound 时无条件合并样本；名单卡的 Preview 切换只控制该侧 sparkline。已有桌面验收还要求没有月度开关。[合并](../dsh-plugins/lg-dashboard/src/usage-preview.js#L18) · [显示](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L47) · [既有验收](../dsh-plugins/lg-dashboard/tests/unified-statistics-desktop.mjs#L21) | **需产品决定。** 保留样例、现有图形与日常无限额测试。建议让真实视图和演示视图各自有明确的数据来源，或至少在混合展示处标识来源。空账本应能查到真实的 0，演示仍能重现 360 条。不要据此改计费、预算或 Agent 调度。行为置信度高。 |
| **静态 UI 素材占发布入口的 91.4%。** 十张实际引用的头像均为 1254×1254，角色头像显示为 54px，搭档显示为 34px。esbuild 把它们内联成 16,200,741 字节；全部 npm 模块合计约 363 KB，离线价格约 722 KB。[loader](../dsh-plugins/scripts/build.mjs#L25) · [头像](../dsh-plugins/lg-dashboard/src/team-panel.css#L24) · [搭档](../dsh-plugins/lg-dashboard/src/team-roster.jsx#L41) | 先试同一图的合适分发尺寸，保留作者原图，实测高 DPI、缩放、透明边、深浅色、冷加载。达标才采用。独立资源加载需要宿主支持，可留作第二选择。保留 Motion 和现有视觉行为。逐文件贡献已量化，未实测启动加速。 |
| **导航意图有两处可写来源。** 外部 openBook 同时改 `navigation.target` 与 React view，内部打开书仅改 view。重挂按 target 初始化，`lastBook → initialBook` 到 DashboardRoot 后没有消费者。同书再次收到 discover 意图时，子组件按 path 作 key，加载 effect 只在挂载执行。[初始化与书架点击](../dsh-plugins/lg-dashboard/src/client.jsx#L144) · [外部调用](../dsh-plugins/lg-brand/src/client.js#L25) | 给内外导航共用一个转移入口，保留挂载前的待处理意图；删无读者的记忆链。先锁定返书架、重复点侧栏、重开同书、跨书、候选定位、宿主卸载重挂行为。不要将“一律记住上一本书”设为新默认。静态置信度高，重挂频率待验证。 |
| **断开的明细 UI 仍有对应载荷。** Teams overview 随轮询返回完整目录、汇总及最多 300 条 `monitoring.series`，取任务时先解码任务集合再过滤并截取 100 条。当前挂载图以 roles/timeline 为主；每次按书过滤的请求也会先解码时段内全部请求。[周期读取](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L38) · [账本](../dsh-plugins/lg-agent-teams/src/store.js#L107) · [明细生成](../dsh-plugins/lg-agent-teams/src/telemetry.js#L58) | 优先测 overview 字节和行数，再让当前调用按需省去明细；保留原响应对已有服务调用者的兼容。目录可复用时须考虑运行中 preset 或配置变化。只在压测证实瓶颈后改查询或索引；保留计量历史。当前取数置信度高，协议能否弃旧字段待核实。 |
| **DSH Context 内部路径散入 4 个 Dashboard 源文件、7 个上游源码路径，含类型引用。** 会话聚合集中在 context-data，但价格、日期和图标仍由页面或图表跨包导入；README 中有关独立性的说明易被误读。会话统计实际需要 Context snapshot 路由，基本书架有自己的 Books 路径。[Context 边界](../dsh-plugins/lg-dashboard/src/context-data.js#L1) · [价格](../dsh-plugins/lg-dashboard/src/global.jsx#L15) · [图表](../dsh-plugins/lg-dashboard/src/usage.tsx#L4) · [图标](../dsh-plugins/lg-dashboard/src/icons.jsx#L3) | 使用现有 context-data 收口统计语义、离线价格入口，图标留在已有 icons 边界；用小型本地 props 表达图表真正消费的字段。以升级一次上游需改几处衡量；不复制统计公式，不为单函数新增 Facade。冻结多模型计费、未知价格、全局七天和 Activity 口径。置信度高。 |
| **随包第三方归属需补对照。** pack 清单含 5 个既有 LICENSE 和 NOTICE；实际 bundle 还含 framer-motion、motion-dom、motion-utils。包内现有 NOTICE 与许可证文件中未找到这几项，bundle 中亦未检出 Framer 的版权行。[分发清单](../dsh-plugins/lg-dashboard/package.json#L16) · [NOTICE](../dsh-plugins/lg-dashboard/NOTICE) · [依赖声明](../dsh-plugins/package.json) | 对照锁文件、esbuild 输入与上游 LICENSE，核对整 App 分发是否已有汇总，再将独立插件所需声明随包带上。保留 Bencho 原稿、作者素材、Apache/MIT 等既有说明。插件包的核对置信度高，整 App 的许可汇总待核实。 |
| **作者的阅读位置被刷新动作重置。** `key={section+refresh}` 会重挂 People/Plot/World，进而重置子页签和搜索。资料版本变化时分页回首页另有专门判断。[刷新键](../dsh-plugins/lg-dashboard/src/story-data.jsx#L77) · [分页版本](../dsh-plugins/lg-dashboard/src/story-browser.jsx#L19) | 将刷新传入数据读取，保留仍有效的筛选和人物位置，失效对象再提示或回退。用刷新“章节梗概”“伏笔”和人物经历的桌面用例确认作者预期。减少按刷新强制重建的路径。静态置信度高，预期属于产品细节。 |

还有一处需要明确的范围语义。Activity 点击的单日传入 Global 的 `range`，TeamPanels 的 overview 请求却只发 `period`；服务返回 timeline 时，名单也从 timeline 取日期。固定“最近七天”和全时段 Activity 已有专门契约；团队卡是否应该跟随点选日，应标清适用范围，或由作者决定同步。收入 `¥0`、收益倍数 `0×` 和待接入的创作转化效率也都是产品占位。建议在排版与数据来源明确前冻结这类衍生指标的扩建。它们和装饰角色均不应作为文学质量的评价依据。[筛选与指标](../dsh-plugins/lg-dashboard/src/global.jsx#L98) · [团队时间范围](../dsh-plugins/lg-dashboard/src/team-panel.jsx#L40) · [当前统计口径测试](../dsh-plugins/lg-dashboard/tests/context-data.test.mjs#L27)

### P3　可以顺手收敛的维护点

- **同一图表样式在一组里注入六次。** AgentTimelines 注入一次，五个 StackedBars 各注入一次。保留组级一次，若有独立预览实例则在其预览根注入，目标 6→1 个 style 节点。构建器本已共享 CSS 字符串，不预计 bundle 相应缩小。验收独立夹具、悬停、键盘、深色和减少动画。置信度高。[父级](../dsh-plugins/lg-dashboard/src/components/AgentTimelines.jsx#L9) · [子级](../dsh-plugins/lg-dashboard/src/components/StackedBars.tsx#L93)
- **价格快照日期硬编码在双语说明。** 构建已提供 `generatedAt`，Global 脚注另写固定日期。下一次换快照容易只更新一侧；用同一次打包输入生成日期，验证中英文及离线价格未知状态。减少一个需人工同步的值。置信度高。[构建](../dsh-plugins/scripts/build.mjs#L16) · [脚注](../dsh-plugins/lg-dashboard/src/global.jsx#L164)
- **示例源码、候选素材与生产代码同放 src。** 可达性检查发现 Bencho 原示例、4 张候选 PNG、候选对白、编辑指南等未入包。交接明确原示例留作出处，正式素材与候选也有区分。建议先在现有说明标出归属，暂不搬目录。只有证明移动不会破坏编辑手册、测试和素材来源，才有维护收益。置信度高。[原示例用途](handoff.md#L115) · [素材说明](../dsh-plugins/lg-dashboard/src/assets/companions.md)

## 四、推荐目标架构与实施顺序

沿现有模块维持四个职责。**DSH 宿主**提供加载、插槽、工作区、会话跳转和可选服务。**Dashboard**由书架导航、单书阅读、使用统计三组视图组成，只持有当前查询、展开与展示状态。**Books / Teams / Context**各自负责作品事实与版本、团队账本、宿主会话数据；跨源展示必须能说明具体口径。**Workbench / Agent Runtime**继续承担作者编辑采用和模型执行。无需为此拆成四个新包。

保留现有的请求取消、Context 单飞轮询、作品边界检查、版本化分页、未知值、来源校验及备份。两个轮询的服务与失败模式不同，一次性写操作也不适合套读请求的重试逻辑。独立 VS Code Webview 的快照发送器有背压和生命周期职责，不能因 DSH UI 使用 React 本地状态就跨宿主替换。[请求生命周期](../dsh-plugins/lg-dashboard/src/api.js#L11) · [范围变更检测](../dsh-plugins/lg-dashboard/src/story-read.js#L14) · [VS Code 快照发送](../LiteraryAgent/lg-vscode/src/host/LatestSnapshotSender.ts#L3)

| 批次 | 改动边界 | 合并或回退依据 |
|---|---|---|
| 0　固定可信基线 | 记录当前可重建源码及产物；修正两个失效的测试夹具；加入跨书失败、后章历史、同任务完成的合成用例 | 原行为缺陷在修复前应可复现。保存可回退产物，默认工作树 HEAD 单独不足以回退 |
| 1　纠正读取范围 | 先改 Books 的可选历史范围，再接 StoryRecord；Teams 前端按范围发布结果、刷新任务详情、约束请求桶数。三件事可分别验收 | 全书历史仍可查，限定范围不带出后章；A/B 不串书；四种指标、六档时间和未启用插件都能工作。任一项失败只回退该项 |
| 2　去除确定不可达实现 | 单列两个文件的具体删除范围并取得授权。清理无消费者符号、重复 style；导航单独一改 | 运行静态反查、注册、节点计数、书架与候选版本跳转回归。发布动作、插槽和 peer 数保持基线 |
| 3　收敛读取成本 | 同事务只算一次 revision；再优化同步内目录扫描。跨书摘要及 Teams 紧凑返回只在测量后实施 | 按 1/10/50 本书、跨章修订、部分损坏作品、来源变更及大区间对照；输出和 token 保持一致，记录查询与字节下降 |
| 4　分发与展示 | 处理随包声明；独立验证头像分发优化；在作者决定后标明真实/样例指标和单日筛选范围 | 离线安装，注册和点开实际页面，比较冷启动、资源体积、透明边缘、390px、深浅色、键盘及减少动画。保留 Beta 实验和日常模型设置 |

## 五、本轮验证记录

| 证据 | 结果 |
|---|---|
| LitIsLand 隔离副本，项目自备 Node v24.22.1，运行 `node scripts/build.mjs lg-dashboard` | 通过。另在真实项目路径按相同构建参数以内存方式比较磁盘 bundle，字节一致；避免把隔离目录造成的源码路径注释差异误判成产物漂移 |
| `node --test lg-dashboard/tests/*.test.mjs` | 44/44 通过 |
| 上组加 6 个跨包 Dashboard 测试文件 | 66/67 通过，失败为旧对白断言。44 个包内用例已包含在 67 个内 |
| `node --test --test-name-pattern='^lg-dashboard:' tests/client.test.mjs` | 0/1 通过，旧 React 替身失败。另用真实 React 的隔离 VM，当前 bundle 的 factory 和三个插槽注册通过 |
| Books 读模型、故事数据、展示及 Teams telemetry 的 4 个边界测试文件 | 27/27 通过。覆盖候选与确认、角色认知、历史、正文定位及用量口径 |
| 四组定向实验 | 真实 TeamPanels + React DOM/合成网络复现 A→B 错配；真实 SQLite 合成作品复现列表/历史范围差；空账本复现 84/360 次样本；前后端实际容量函数复现 1 桶被拒。另测到单次 overview 的 2 次版本全文查询 |
| 发布核对 | 离线 `npm pack --dry-run --json --ignore-scripts`；本地 desktop profile 链接解析到当前插件。未用作者日常 App 做新一轮 Electron 视觉验收，未重跑全工作区默认套件、VS Code 集成或单独类型检查。历史桌面记录只用来识别应保留的行为 |

本阶段交付为审查报告。进入代码阶段时建议先验收批次 0 与跨书修复。最小而有意义的成功标准是，同一份合成书架既能稳定复现旧问题，也能在改动后证明新书、旧书及其候选始终对应正确。
