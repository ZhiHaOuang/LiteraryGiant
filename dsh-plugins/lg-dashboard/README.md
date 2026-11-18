# 小说控制台

从小说内容查看简介、字数、章节、人物、事实与伏笔。

版本 0.1.0。Host 使用 DSH Cordis 生命周期和已认证的 connection.fetch；不启动 Python、Codex 或额外服务器。

依赖 `lg-books`。使用原生 main / sidebar.panellist 插槽；复用 DSH 主题变量，以卡片和明细展示作品。`src/client.jsx` 构建为 client.js。

开发与验收入口见上级 package.json。

控制台的「故事索引」按需读取已登记作品。人物关系和事件连线保留来源及当前版本。材料索引须通过文件哈希校验。预览后可重建 `ReferenceLibrary/indices/story.json`，替换时保留原件。遇到未校验的旧章节分析报告或损坏的来源记录时，界面列出缺口，保留现有磁盘索引。

旧章节人物弧光与事件报告按源快照、存档格式和原文引证校验。可展开查看章节、场景或作者选定方案的原句及版本 ID。正文或方向变化后报告退出当前索引；只变更正式设定时标为待复核。无效引文或不兼容契约会阻止覆盖现有索引。lg-books 所带 analysis-contracts.json 固定自旧程序的 chapter-analysis.schema.json 及 CharacterArc／EventsLibrary 存档实例卡契约，运行时使用 Ajv 2020 校验。

章节进度中的「待审正文版本」包含章节自身及其已归属场景的候选。展开后按版本 ID 倒序分页读取标题、版本和修改目的，点击「审阅此版本」可在启用的文学编辑台比较精确版本。返回控制台时重新读取该作品。全书候选总数仍包含人物等其他文档的候选。

「章节候选监督」显示所选作品实际启用的审阅类别。已有作品可以在这里启用五类监督；新建预览会列出监督文件。损坏的策略在本栏显示错误，仍可查看作品概况。

## 2026-11-08 界面

2026-11-12：Chapter Progress 固定每页 10 章，宽屏卡片上下边缘跟随左侧内容，候选详情在右卡内部滚动，分页始终位于底部。窄屏独立排列并限制卡片高度。图表点击定位、初始章节定位和筛选均使用相同分页大小。橙色统一为主题 `--dsw-alias-brand-primary`（回退 #d97757），覆盖柱图、环图、进度条与图例。

人物资料已接入 1.1 的重要等级和叙事身份，保留候选、范围及冲突；规则见父仓库 docs/story-time-v1.1.md。`tests/book-layout-desktop.mjs` 使用独立合成 profile（37 章及两条全书人物身份），验证 10/10/10/7 分页、展开前后和左栏高度变化时对齐、图表定位、人物评级与依据、主题色、390px 及深色。环境变量沿用下文的三项桌面测试配置。

控制台沿用 dsh-context 0.82.1 的紧凑卡片、主题变量、分段按钮与容器响应式布局。对应参考为 src/client/styles/base.css、styles/stats.css、components/statsTokens.tsx、components/donut.tsx 和 components/contextView.tsx。改编样式独立使用 lgd 前缀，来源与许可见 NOTICE / LICENSE-dsh-context；不依赖 dsh-context 的会话投影服务或 CSS 加载顺序。

作品统计与简介位于顶部，字数组成和章节覆盖居中；下方按双栏排列字数分布与可展开章节。所有数字来自现有 literaryBooks 快照，不显示虚构的历史趋势。点击柱形定位章节，章节支持搜索、待审筛选与候选审阅；管理作品保留添加和新建入口。具体文学模块职责将按作者体验继续细化。

本批使用合成作品验证展开、筛选、搜索和图表跳转，中英文界面、390px 窄栏及深色主题无横向溢出。未改变作品服务、采用规则或模型调用。


## Global dashboard (2026-11-08)

The Novel dashboard entry opens the global bookshelf overview. Book names open the
existing book dashboard; candidate rows open the matching chapter for review.
The global page uses two equal analytics columns, a full-width book table and
three Agent / Skill / Tool cards. Date ranges apply to usage, while book progress
and running sessions remain current snapshots.

Usage aggregation is bundled from the pinned sibling dsh-context 0.82.1 source.
Prices are bundled offline from @opencode-ai/models 0.0.87 (2026-09-27 snapshot);
opening the dashboard does not fetch remote prices or invoke models. Amounts
are estimates, including only priced DSH usage, not provider invoices. Historical
LG execution-ledger calls are not yet included. Book attribution uses the current
session directory with path-boundary matching; historical immutable attribution
is not available. Stage, adoption-history efficiency and unified failed literary
tasks remain unavailable and are explicitly labelled.

Build this plugin with `node scripts/build.mjs lg-dashboard` from dsh-plugins.
Run `node --test lg-dashboard/tests/global.test.mjs` for adapter regressions.

Build dependency installation uses `npm install --legacy-peer-deps`: the pinned
upstream workspace utility declares an older Cordis peer range; only its pure
path utility is bundled, and no alternate Cordis runtime is installed.

## Books 与 Library 独立选择

首次设置以及书架“设置两个目录”提供两个独立选择器，分别预填已选 Books 和 Library 路径。两者无需位于同一父目录，直接使用选中的目录本身。只修改 Library 不改变 Books 或其 workspace；新书建在所选 Books 目录下。保存后加载全局 Dashboard，书名和 workspace 菜单打开本书 Dashboard。不会自动移动旧作品或对话。

## Dashboard 内部收敛（2026-11-09）

范围仅为本插件及上级 `package.json` 的测试入口。现有卡片、样式有效值、Host 路由和产品操作契约保持不变。

- 删除未被导入的 `workspace-navigation.js`、`workspace-sidebar.css`，移除未使用的图标、辅助函数和样式规则；保留全部来源与许可证。
- 六处 Books 请求实现统一为 `src/api.js` 的 `requestBooks`；错误向调用页面报告，写操作不自动重试。Context 轮询与手动刷新共用正在进行的请求，完成后再安排下一次轮询，卸载后忽略结果。
- 主页面由 `useShelf` 持有书架清单，单书导航和 workspace 按钮复用它。刷新、创建/添加后以及外部 workspace 导航重新读取清单。独立 onboarding 插槽保留自己的生命周期；没有引入全局状态总线。
- `global-data.js` 一次完成会话归属和最近活动计算；`context-data.js` 复用上游计算并按作品汇总，供环图和表格共同使用。最近七天及 Activity 仍独立于顶部筛选，未改变统计口径。
- 合并重复 CSS 声明，删除原本没有匹配容器的 `lc-ov` 规则，保留现有窄栏表现。

实现文件数量保持 19（包含 Host `index.js`）；新增两个小型模块替换两个无用文件。没有新增依赖、Host API 或消息协议；代码规模不作为精简目标。

在 `dsh-plugins` 目录执行：

```sh
node --test lg-dashboard/tests/*.test.mjs
node scripts/build.mjs lg-dashboard
```

默认 `npm test` 已包含 Dashboard。单元测试覆盖请求契约、错误处理、轮询竞争、归属边界、统计口径、日期窗口、候选链接与 provider 信息边界。

`tests/desktop.mjs` 是单独运行的真实 App 回归，需要 Playwright、现有 App 可执行文件及已准备好的无凭据合成 profile，不随 `npm test` 启动。环境变量为 `LG_PLAYWRIGHT_MODULE`、`LG_APP_EXECUTABLE`、`LG_DASHBOARD_TEST_ROOT`，可用 `LG_DASHBOARD_HOME` 指定实际项目插件所在的测试 profile。测试根目录必须含 `.dashboard-test-profile` 标记、`home-baseline`、`home`、Books 内的两本合成书“潮汐来信”和“山间来客”，以及独立 Library；两份 profile 分别加载改动前后插件。只使用合成目录，不能指向日常 profile。

桌面回归比较宽屏/390px 窄栏的关键布局尺寸，并验证日期切换、作品和章节搜索、候选展开、单书导航、刷新请求数、目录独立保存、新建预览取消、主页面与首次设置失败后的重试。真实模型生成、正式正文采用和实际新书写入不属于这轮桌面回归；没有调用收费模型。

本轮验收：Dashboard 单元测试 15/15、默认测试入口 339/339、插件构建及现有 LiteraryGiant App 的隔离 profile 回归均通过。合成场景中首次加载 shelf 请求由 3 次降至 2 次（含独立 onboarding），从全局打开单书由 `list → read → shelf` 降至一次 `read`；手动刷新仍为一次 shelf 加每本书一次 read。宽屏与窄栏关键卡片尺寸逐项一致，深色主题截图已检查。源码 `src/` 为 18 个文件，行数由 1167 增至 1186，体积由 100043 降至 99572 字节；新增的请求生命周期和纯统计模块用于减少重复职责，不追求机械减少行数。
