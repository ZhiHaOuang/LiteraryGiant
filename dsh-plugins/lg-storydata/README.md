# lg-storydata

左栏 **Story Data** 在同一页展示书架存储、信息协议和已审查条目。**Information Protocol** 标题栏右侧可切换 **Compact / Extend**。Extend 默认打开，可在 Characters、Plots、Environment 之间切换，左栏选择大类，中栏列出细分项，右栏显示用途、词项和示例。Compact 将这三个板块依次向下排列，每行的大类及其浅色实底标签使用同一色系，点击标签可直接进入该板块对应的 Extend 讲解。窄面板自动换行。顶部统计包含已登记的归档书。展开 **Book Records** 选择作品，可按模块和类别读取条目、标签与适用范围，每页最多 30 条。

## 情节与环境的创作目录

目录中的用途、词项与示例供作者构思和审读时按需查阅。下表是 LG 对研究与创作实践的转化。判断一个细分项值不值得保留，可以看它能否改变一次具体的写作决定，或者帮助追查前后文之间的矛盾。中文例句为本项目编写。

| 视图与分类 | 创作或审读时要查什么 | 研究与实践依据 |
| --- | --- | --- |
| Plots · 行动与因果 | 比较目标、可选行动、直接结果和延迟后果。先后相邻的两件事可能只有时间关系。 | Trabasso 与 van den Broek 对故事材料的再分析发现，事件在因果链中的位置和连接数能解释回忆、概括与重要性判断的部分差异。[原论文](https://cs.uky.edu/~sgware/reading/papers/trabassovandenbroek1985causal.pdf) |
| Plots · 时序与节奏 | 分别核对事件先后、讲述顺序、展开篇幅和重复次数。两人先后回忆同一次失火，故事中仍只失火一次。 | Scheffel、Weixler 与 Werner 梳理了故事时间和讲述时间之间的顺序、时长和频率关系。[Time](https://home.uni-leipzig.de/detoro/wp-content/uploads/2023/02/Revision-of-Time-from-Sat-19.-April-2014-the-living-handbook-of-narratology.pdf) |
| Plots · 线索与揭示 | 分开追踪前文证据、读者所知和预想回收。修改揭示位置时，才能判断变化影响的是对结果的期待、对前因的好奇，还是对旧解释的修正。 | Brewer 与 Lichtenstein 研究了相同事件采用不同呈现顺序时产生的不同阅读感受。[研究报告](https://www.ideals.illinois.edu/items/17648/bitstreams/63415/data.pdf) |
| Plots · 篇章与线索推进 | 检查场景首尾改了什么，支线何时改变主线，本章兑现什么、下章接什么。章末可以留下待解问题，也可以给出阶段结局。 | 作家课程区分目标推进感与时间流逝。另有两项书面叙事实验发现，悬置结尾在部分比较中提高了对续篇的需求，愉悦感和悬念评分未见显著差异。[Writing Excuses](https://writingexcuses.com/writing-excuses-10-31-how-do-i-control-the-readers-sense-of-progress/) · [Schibler 等人的实验](https://researchconnect.suny.edu/en/publications/investigating-responses-to-narrative-cliffhangers-using-affective/) |
| Environment · 地点与通行、场景与感知 | 分清城镇与路线、人物所在的具体位置，以及这个人此刻听见或看见的东西。地点沿革和离场痕迹帮助核对再次到访的场景。 | Ryan 区分行动所在的局部空间、较广的背景及与情节有关的空间。开放大学的写作课让作者比较心境和处境如何改变对同一地点的感受。[Space](https://www-archiv.fdm.uni-hamburg.de/lhn/node/55.html) · [Start writing fiction](https://www.open.edu/openlearn/history-the-arts/creative-writing/start-writing-fiction/content-section-1.3/?printable=1) |
| Environment · 自然与物质条件、制度与日常 | 追踪人物用到的一项资源怎样取得、谁能通行、谁负责执行。天气、交易或习俗对当前选择有影响时，再补相应细节。 | Wrede 从交通、技术、贸易与公共生活推演世界设定的日常后果。[地理与资源](https://pcwrede.com/fantasy-worldbuilding-questions-physical-and-historical-features/) · [商业与公共生活](https://pcwrede.com/pcw-wp/fantasy-worldbuilding-questions-commerce-trade-and-public-life/) |
| Environment · 世界规则与边界 | 区分触发条件、能力上限、使用成本和有效期。可用于现实政策、虚构技术或超自然设定。 | Wrede 的魔法设计问题明确区分能力限制、代价和例外。将这组问题推广到其他规则是 LG 的设计选择。[Magic and Magicians](https://pcwrede.com/pcw-wp/fantasy-worldbuilding-questions-magic-and-magicians/) |

**与已有数据的关系。** 两种布局读取[同一份创作目录](src/plot-environment-protocol.js)。Plots 的「情节资料字段」和 Environment 的「环境资料字段」另从 Books 目录读取实际字段。以封渡为例，通行规则的适用条件可查世界设定记录，某次错过渡船的行动与后果可查事件记录，何时向读者交代原因可查揭示记录。氛围、节奏与因果解释属于审读判断。本次新增的是只读参考词表，采纳作品资料仍走现有版本、来源和审查流程。

## 书架存储

- `POST /api/lg/storydata` 的 `storage` 动作返回 `lg.storydata.space.v1`。统计所有已登记书目录下普通文件的字节长度。跳过符号链接，嵌套书目录和硬链接只计一次。宿主集中保存的聊天在书目录之外，Conversations 统计书内的会话及其制品。统计口径为文件长度，文件系统压缩和块分配会影响系统显示的磁盘占用。
- Manuscript 计正文目录，Main dossiers 计 SQLite 中 Main 表和索引占用的页，Story archives 计提取记录表占用的页与书内资料快照。数据库其余空间归 Database。有待合并的 WAL 或 SQLite 缺少 dbstat 时，数据库整体归 Database。人物、情节和环境按已有专属文件目录归类。无法细分的文件保留在 Other files。
- 打开、刷新或收到书架变更时测量。每条趋势柱对应一次实际观察到的书架章节位置，横轴是各书章节数之和。同一位置保留最新体积，Delta 比较上一个观察位置；首个位置使用首次采样作基线。两次测量间跨过的位置留缺。每条序列返回最近 120 个观察位置。
- 专门的情节插件可提供 `literaryPlotSegments.count(bookPath)`，返回已划分的非负整数数量，未划分时返回 `null`。全部参与作品具有计数后才记录 Plots 序列；章节、场景和 Main 修订均不会自动成为情节。
- 采样历史保存在 DSH profile 内的 `lg-storydata/storage-history.sqlite3`，只含书架及进度指纹、位置和分类字节数。书架成员改变时使用对应书架的序列，部分作品不可读时标记不完整并跳过采样。无 profile 的独立宿主仅保留当前会话的历史。

只读 `POST /api/lg/storydata` 的 `overview`、`book` 动作返回 `lg.storydata.inventory.v1`。book 接受已登记作品的 path 与可选 options（module、facet、section、offset）。人物结构化模块按 entries 中的条目数计，通用摘要和书级扩展摘要各计一条。提取记录按当前 head 的类型与审查状态另计。候选 Main 与历史修订不计入当前条目。协议词表示例不参与计数。

宿主主服务为 `literaryStoryData`。兼容服务 `literaryOutline`、既有 `/api/lg/outline`、`lg.outline.*` 数据格式和书内表名继续可用。宿主通过 Books 登记和事务读取作品。正文 SQLite 的编辑与版本管理仍由 Books 负责。


书级 Main 保存审查过的当前理解。人物、情节、环境使用同一套更新协议，分别用 `people`、`plot`、`world` 筛选。一个人物可以引用一个承诺所在的情节档案，Dashboard 可沿链接打开情节。摘要的依据性质用 `text` 或 `inference` 表示。所有 Main 模块的身份均为 `reviewed_summary`，作者确认事实和采纳正文仍走现有授权接口。

## 书级协议

- 同一本书内 `id` 持久标识一个档案。已有故事资料实体优先沿用原 ID，人物详情按 ID 读取。首版固定档案名和板块，同一档案可包含多个模块。当前条目的键是 `(id,module)`。
- 基础包 `core@1.summary` 提供一个最多 800 字符的摘要和指向其他档案的有向链接。上层分析负责比较现状，提议保留哪项变化。无变化可传空数组。插件识别相同文字、依据性质和关联，语义相近的改写仍需审查员筛选。
- `beat` 描述这次变化对应的情节点。修订号表示 Main 的更新次序。正文位置由来源定位，故事内的先后仍可使用既有事件与时序服务。
- 每个模块独立携带原文依据。使用文档 ID、当前版本 ID、版本原文 UTF-8 SHA-256、从 1 开始的非空行号和逐字引文。活动章节／场景的 draft、accepted、final 版本可作为依据。数据库内的引用随书移动。
- 来源改变时只读接口会标出 `stale`。审查期间 Main 版本或新证据变动会阻止提交。来源纠正可保留相同的摘要，重新绑定证据并生成修订。
- 每次更新可同时变更多个板块。服务在单笔书级事务里检查版本、来源与关联，并一起推进各模块版本。相同提交重试返回原收据。History 保留每一版完整条目、审查理由和候选标识。

## 人物 core v1

人物 Main 内置八个独立版本的模块。稳定标识、40 个二级类别与起步词表见 [人物目录](src/character-core.json)。宿主用 `characterProtocol()` 取得同一目录、条目 Schema 和审查规则。专业题材继续用按书启用的扩展。

- 写入时使用 `core@1.identity/goals/personality/abilities/situation/knowledge/relationships/milestones` 中对应的模块，例如 `core@1.identity`。每个模块提交完整的 `entries`，每条含稳定 key、facet、value、tags、scope、nature、sources。文学标签用短词，命题、取舍及条件用短句。
- `sources` 的数字从 1 起，对应本模块的 evidence。正文锚点与可选故事内 `time` 分开。目标的跨度和进展、认知态度、关系对象与方向、经历的情节引用由服务校验。关系对象有本书 ID 时填写 target_id。两个经历的时序或因果用 event_id、event_relation、related_event_id 按起点至终点记录。
- 更新前按人物 ID 和模块读取旧版本，比较哪些条目仍有效。新证据仅重复同一含义时可零更新。清空模块提交空 entries，需给出文本、依据并经过独立审查。旧版本及其逐条引文通过 history 回查。
- `POST /api/lg/outline` 使用 `{"action":"character","path":"<已登记作品>","options":{"id":"<人物ID>"}}`。响应 `lg.outline.character.v1` 返回 id、book_id 和按展示顺序排列的 groups。每个 group 含 module、label、facets 与 item。无已审查模块时 item 为 null。已审查组提供条目、版本、来源新鲜度和 related。默认展示投影省略原文引文。旧摘要和按书扩展可从 main 的 other_modules 筛选读取。
- 此接口是作者当前资料视图。样例书的罗兰资料明确限定第一章；故事内其他时间或角色可见性的计算另由相应投影处理。

## 消费接口

DSH 提供 `literaryOutline` 服务，依赖 `literaryBooks`。作品登记和事务复用 Books。书内 SQLite 在首次写入时初始化 `lg_outline_*` 表。旧版资料继续通过原来的接口读取。首次启用的书，其 Main 为空。

1. 用 `main(path,{section,id,offset,limit})` 读取作者当前视图，取得待更新模块的 revision。单页默认 30 条，最多 100 条。
2. 用 `propose(path,proposal,actor)` 提交符合 [更新 Schema](src/contract.json) 的对象。新模块填 `expected_revision: 0`。同批可引用新建档案。服务返回不可变的候选 token，或 `no_change`。
3. 审查员用 `inspect(path,token)` 比较每项 before / after 及原文，判断信息是否值得保留。用 `review(path,token,{decision,reason},reviewer)` 提交 approved 或 rejected。调用方从实际会话身份绑定 actor 与 reviewer。两者必须不同。此接口信任宿主插件身份，不是操作系统的身份认证。
4. `commit(path,token)` 只应用通过审查的精确候选。按条目溯源使用 `history(path,{id,module,offset,limit})`。
5. Dashboard 的三个板块有「当前档案 Main」入口，按需调用只读 `POST /api/lg/outline`，请求为 `{action:"main",path,options}`，响应标识为 `lg.outline.read.v1`。此接口只支持作者当前视图。人物受限视角与历史截止章需要独立的投影。

宿主或本地调用方可用 `enablePack(path,{id,version,modules})` 启用书级扩展，例如 `{"id":"example","version":1,"modules":{"note":["people"]}}`。之后该书的人物档案可选填 `example@1.note`。每本书固定包定义，`packs(path)` 可读取。首版扩展复用同一摘要结构，新的字段类型和包升级迁移可随实际内容 core 增加。

## 本地运行

在仓库根目录运行下列命令。BOOK 指向明确选定的 LG 作品目录。change.json 是调用方生成的候选，review.json 含审查决定与理由。命令共享插件使用的版本检查、来源检查和事务规则。写入者与审查者由本地操作者指定，接入 Agent 时应从受信任的任务绑定取得身份。

```sh
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs main "$BOOK" people
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs propose "$BOOK" "$ANALYST" < change.json
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs inspect "$BOOK" "$TOKEN"
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs review "$BOOK" "$TOKEN" "$REVIEWER" < review.json
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs commit "$BOOK" "$TOKEN"
.dsh-dev/node/bin/node dsh-plugins/scripts/outline.mjs history "$BOOK" "$PERSON_ID" core@1.summary
```

用以下命令在自动新建的合成书上运行完整示例。测试覆盖人物与情节联动、环境摘要、来源变更、并发候选和重启。

```sh
.dsh-dev/node/bin/node --test dsh-plugins/lg-storydata/tests/outline.test.mjs
```

桌面端在「插件 → 添加插件」启用指向本仓库 `dsh-plugins/lg-storydata` 目录的 `link:` 插件，按宿主提示加载。Dashboard 客户端使用本仓库已构建版本。LG 主会话已接入提议、独立审查和提交。详见 [Agent Teams 的 Main 操作说明](../lg-agent-teams/README.md)。本地 CLI 也可使用同一协议。

