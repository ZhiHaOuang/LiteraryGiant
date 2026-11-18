# reading-workbench 阅读工作台插件

把 DeepSeek Harness（DSH）变成阅读工作台：书架、分页阅读器、划线批注，并让 Agent 能直接读到你在读的正文。

## 功能

- **书架**：封面网格；支持 Markdown / TXT / HTML / EPUB / MOBI / PDF，另可把网页书源抓取成本地章节书
- **分页阅读器**：单页 / 双页，滚轮与键盘翻页，进度按「页码 + 百分比」双锚点保存
- **划线批注**：文本偏移锚点，页面重排后仍能恢复；支持与对话联动
- **阅读设置**：字号、行距、页宽、明暗主题；TXT 可切换「自动合并折行 / 保留原样」
- **Agent 工具**：`reading_books`（书目）、`reading_highlights`（划线）、`reading_excerpt`（正文节选）

## 安装

```powershell
dsh plugin --profile <profile> add dsh-reading-workbench
```

尚未发布到 npm 时，也可以直接用源码目录安装：在 profile 的 `package.json` 里以 `link:` 指向本目录，
并把包名加进 `dsh.profile.bundles`。Host 半代码改动需**重启 DSH** 才生效（Node ESM 模块缓存，
disable/enable 不重载）。

## 截图

> 待补。市场卡片优先展示作者策展的截图，且只接受 GitHub 图床地址。

## 开发状态

> 说明：下文出现的 `docs/...` 路径属于开发工作区（`dsh-plugin/docs`），**不在本仓库内**，
> 仅作为设计依据与实测记录的引用。

> 状态：**三期完成并已通过真实例验收（2026-10-19）；本轮新增滚轮翻页 + TXT 段落重排**。
> v1 的多格式支持（EPUB / MOBI / PDF）已在真实实例通过验收。
>
> TXT 重排（2026-10-19 本轮）：TXT 正文从「一个大 `pre` 原样保留源文件换行」改为
> **按段边界判据合并折行 + 每段一个 `p` + 首行缩进 2em + 段间距**，并提供
> 「换行：自动合并 / 保留原样」设置项。判据、偏移契约与全库实测依据见
> `docs/txt-reflow-design.md`；
> 独立对抗验收报告见 `docs/diag-txt-linebreak/2026-10-19-reflow-verification.md`。
>
> 全部自测套件全绿（21 套既有 + 本轮新增 `txt-layout-selftest` **193 项**、
> 独立验收 `txt-reflow-check` **1817 项**、真实浏览器几何 `txt-reflow-browser-check` **18 项**）；tsc 0 错误。
> **真实实例验收**：三格式 + 封面 + 设置 + 划线 PATCH + 进度锚点全部通过（`fiberPhase: active`）。
> 本文档是该插件的唯一权威设计来源，随开发持续更新。
> 遵循工作区根目录 `agents.md` 规范；运行时契约以当天 inspect 为准，基准探查见 `docs/dsh-runtime-notes.md`（构建实测经验在第 10、11 节）。

## Host 半运行在 vm 沙箱里（2026-10-19 两次真实事故，必读）

插件 install 成功、产物正确、静态 import 全部可解析，但 DSH 里 `fiberPhase` 一直 `failed`、
全部 REST 路由 401/404。**两轮排查抓到两个独立根因**。

### 事故一：沙箱里没有 `process` / `Buffer`

`apply` 第一行的 `process.env.DSH_HOME` 直接抛 `ReferenceError: process is not defined`，
cordis 记 `_error`、state 转 `FAILED`，**连 14 条路由一起消失**；`writeJson` 里的
`Buffer.byteLength` 是第二颗地雷（首次响应才炸）。

修复：数据目录改由 `config.dshHome` / `ctx.get('sandbox'|'storage'|'workspace')` 提供并回落 `~/.dsh`；
编解码统一 `TextEncoder` / `TextDecoder`；`readBody` 返回 `Uint8Array`。

### 事故二：`ctx.tools` 没写进 `inject`

修完事故一仍然 failed。这次用**宿主自己的启动参数起副本、把 stderr 落盘**，才看到真话：

```text
reading-workbench: Error: cannot get property "tools" without inject
    at …/lib/index.mjs:1612:12
```

cordis 里读**未 inject 的服务**是**抛异常**而不是返回 `undefined`——于是
`if (ctx.tools === undefined)` 这种"判空跳过"自己就会炸，且炸在 `ctx.effect` 回调里
会被记成整条 fiber FAILED，`try/catch` 兜不住。

修复：`inject = ['webServer', 'tools']`；服务读取移到 effect 之外并显式 try/catch，
取不到就只少三个工具，书架与阅读照常。

**排查心法**：`list_plugins` 只给一个 `fiberPhase: "failed"` 字符串，没有异常文本。
最快的路径永远是**抓宿主 stderr**，别靠本地猜。

防线：`scripts/sandbox-contract-check.mjs`（已接进 `pnpm build` / `pnpm check`）——
在**不带 process 的 vm 沙箱** + 真实 cordis + **白名单 ctx Proxy** 里跑 apply，断言 ACTIVE，
并带多条断言/反证（还原 `process.env` 必 FAILED；漏声明 `tools` 时只少工具、不拖垮宿主）。
完整事故复盘见 `docs/m2-agent-tools-notes.md` 第三、四节。

## 文本编码契约（2026-10-19 事故三，必读）

**症状**：导入一本 GBK 老 txt（`蓝天航空公司的空姐.txt`，1.05 MB）后满屏菱形问号
（`�`），夹杂零星拉丁/西里尔/希腊字母；同一本书打开还特别慢。

**根因**（两层，缺一不可）：

1. **编码**：`File.text()` / `readFile(path,'utf8')` 都是「UTF-8 宽松解码」，
   GBK 字节被逐段解成 U+FFFD（`�`）；恰好构成合法 UTF-8 序列的字节对被解成别的文字
   （`D5 B9` → 希伯来文等）。更糟的是导入时把**已损坏的字符串写回书库副本**
   （`library/<id>.txt`），损坏被永久固化 —— 该副本 2.44 MB，含 681,143 个替换符。
2. **性能**：txt 没有章节结构，旧实现把整本书当成一个排版单元塞进 CSS 多栏容器
   （`column-fill: auto` + 固定高度），55 万字要一次排出 400~600 列。

**现在立的规矩（改代码时必须守住）**：

1. **导入只收原始字节**：客户端用 `file.arrayBuffer()` 走二进制通道
   （`/books/upload-binary`，`format=txt|md` 也走它），Host 侧统一入口
   `store.importTextBookFromBytes(paths, meta, bytes)`。
   **任何地方都不得先解码再上传/落盘。**
2. **解码严格、二选一、失败即报错**：`shared/text-encoding.ts` 的 `decodeTextBytes`
   按 `BOM → UTF-8(fatal) → GB18030(fatal) → 抛 TextDecodeError` 判定，
   **绝不接受宽松解码产出的替换符**。GB18030 是 GBK/GB2312 的超集，覆盖中文老书。
3. **两道损坏闸门**：
   - 落库前 `inspectReplacementDamage`（>1% 且 ≥20 个）拒绝导入（`importBookFromContent`）；
   - 打开时同一判据命中就报错「本书导入时被错误解码损坏，请重新导入」
     （`store.readBookContent`）—— 已损坏的副本无法修复，只能重导，
     绝不把乱码当正常内容渲染给用户。
4. **副本恒为规范 UTF-8**：`library/<id>.<format>` 只有这一种编码，读取端不再猜。

**txt 虚拟单元（性能）**：`client/txt-units.ts` 的 `splitTextUnits` 把正文切成若干单元
（章节标记行优先，否则约 2 万字一处；整本无换行的长文按字符强制切），
阅读器一次只渲染一个单元。偏移契约：`unit.text === text.slice(unit.start, unit.end)`，
且 `start` 是**全书字符偏移** —— 因此划线锚点仍是全书偏移，旧划线无需迁移，
渲染时用 `toUnitRange` 换算成单元内偏移。实测同一本书：556,817 字 → 27 个单元，
最大单元 36,364 字，单次排版量降到整本的 6.5%。

配套自测：`scripts/encoding-selftest.mjs`（编码表驱动 + 损坏判据 + 切分偏移契约）、
`scripts/host-upload-selftest.mjs` 的 10~12 号用例（GBK 二进制导入 / 非法编码拒绝 /
旧 JSON 通道拦替换符）。已损坏的历史数据用 `docs/diag-blue-sky-encoding/repair-damaged-import.mjs`
重导（自动备份副本与 data.json）。

## Agent 工具（M2，2026-10-16）

三个只读工具把书库接进 DSH 会话（在对话里问「我有哪些书」「那本小说讲了什么」时，Agent 可直接查）：

| 工具 | 参数 | 说明 |
|---|---|---|
| `reading_books` | — | 书架列表（书名/作者/格式/进度）；`render` 输出人读友好的书单 |
| `reading_highlights` | `bookId?` `limit?` | 划线批注（含笔记），按时间倒序；可跨书查 |
| `reading_excerpt` | `bookId` `offset?` `length?` | 正文节选（单次上限 4000 字），章节书剥成纯文本、图片占位为 `[图片]` |

### 关键实现决策：不 import `@deepseek-ai/dsh-tools`

首版直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`，结果**在测试阶段就炸了**：
dsh-tools 0.1.0-rc.6 的 ESM 依赖 `@deepseek-ai/dsh-llm` 的 `CallId` 导出，
而本机运行时的 dsh-llm 0.2.0-rc.2 已把它改名 `ToolCallId` —— 版本族错位，`import` 阶段即抛
`SyntaxError: does not provide an export named 'CallId'`，**会炸掉整个宿主启动**。

复盘 `defineTool` 的源码后确认它只是「schema 编译 + 参数校验包装」的纯数据变换，
因此按同形态自实现（含参数校验、`ToolArgsError`、`parametersToJsonSchema`），
不引入任何 `@deepseek-ai/*` 运行时依赖，工具对象与官方形态逐字段对齐。
`tools-selftest` 验证：注册形态、schema 编译、execute 输出、render 文本、过滤/倒序/limit、HTML 剥离、越界与报错，共 26 项。

设计取舍：工具**只读**（不提供写入/删除）——划线由人类在 GUI 里做，Agent 只消费。

## 划线批注（M3，2026-10-16）

正文选中文字 → 浮动「划线」按钮 → 入库并即时高亮；工具栏「划线 N」打开笔记抽屉。

### 定位模型：文本偏移锚点（重排后仍可恢复）

页码/屏号会随字号与视口变化，**文本不会**，因此划线锚点记录「章节 + 单元内字符偏移 + 长度」：

```text
章节书：mark:ch=2:off=17:len=9     （ch 为章节序；段间 : 分隔、段内 key=value）
文本类：mark:off=120:len=30
```

- 恢复时按偏移在单元文本里重建 `<mark>` 包裹；找不到（内容改版）静默跳过，不报错——`text` 始终随划线存库，笔记栏永远能展示原文。
- **分隔符刻意设计**：段间 `:`、段内 `=`。首版把 key/value 也用 `:` 连接（`mark:ch:5:off:17`），split 后 key 与 value 分家、全部字段解析失败——`mark-selftest` 的往返断言抓住了它。
- 选区超长（>600 字符）拒绝并提示，防止把整章划成一条。
- 笔记随划线存库，`PATCH /highlight?id=` 更新（正文不可改，只允许 note）；空串即清除。

### 交互细节

- 高亮恢复用「逐节点切分 + Range 包裹」而非 `surroundContents` 一把梭——划线常跨段落，后者直接抛错；包不住的片段退化为 extract/insert，再不行就跳过该片段（不破坏 DOM）。
- 点正文里的高亮 → 打开笔记抽屉；抽屉里「定位」按偏移比例换算目标屏并平滑滚动到该句。
- PDF 暂不支持划线（pdf.js 文字层是另一套坐标体系，待做）。

## UI v2：界面结构与交互（2026-10-16 重构）

用户反馈「看书界面太难看」，因此把 UI 从「左窄书架 + 右正文」改成**先书架、后沉浸阅读**两态：

```
┌─ 书架态 ────────────────────────────────────────────┐
│  书架  12 本        [搜索] [排序]      [导入书籍]     │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                │
│  │封面│ │封面│ │封面│ │封面│ │封面│  ← 2:3 书封网格 │
│  └────┘ └────┘ └────┘ └────┘ └────┘  底部进度条     │
│   书名    书名    书名    书名    书名                │
├─ 阅读态（点书进入，占满整屏）──────────────────────┤
│ ‹返回 书名 [章节目录▾]   [自适应|单页|双页] A－ A＋   │
│  ┌──── 分页正文（CSS 多栏，一屏 1~2 栏）────┐        │
│  │  左右点击热区翻页 / 方向键 / 空格 / PgUp/PgDn     │
│  └──────────────────────────────────────────┘        │
│ ‹   章节 3/12 · 5/9 页  ▓▓▓▓░░░░ 62%   ›             │
└──────────────────────────────────────────────────────┘
```

### 分页是怎么实现的

不切分 DOM、不测量每个段落，而是用 **CSS 多栏排版**：

1. 正文容器固定高度 + `column-fill: auto`，整篇内容被排成 N 个等宽列并横向溢出；
2. 外层视口 `overflow: hidden` 只露出**一屏**（单页 = 1 列宽，双页 = 2 列宽 + 间距）；
3. 翻页 = 对内层施加 `translateX(-屏号 × 步长)`。

> ⚠️ **两个几何量必须分清**（曾混用，导致「按键盘下一页切换不准确」）：
> - **flow 宽度** = `screenWidthOf` = 可见列宽之和 + 列之间那 `cols-1` 个间距（一屏能显示的内容宽）；
> - **翻页步长** = `stepOf` = 可见列数 × (列宽 + 间距)（跨到下一屏的实际距离）。
>
> 二者相差恰好一个 `COLUMN_GAP`：一屏右边界止于末列右缘，下一屏首列要从「末列右缘 + 间距」处起排。
> 用 `screenWidth` 当步长会每翻一屏累积偏移 48px —— 左侧露出上一列的尾巴、右侧正文被切。

好处是「页码」是**真实排版结果**：改字号、拉窗口都会自动重排并重算页数；
`ResizeObserver` + 内容区 `load` 监听负责补测（图片加载会改变排版宽度）。

列数由设置决定：`单页` / `双页` 强制，`自适应` 按容器宽度判断（两列都 ≥ 380px 才并排）。

### 翻页手感

- **键盘**：`→`/`↓`/`空格`/`PgDn` 前进，`←`/`↑`/`PgUp` 后退，`Home`/`End` 首末屏，`Esc` 返回书架。
- **连发不丢步**：`nextPage` 内部维护一个**同步推进的目标屏号**（`targetViewRef`），
  不依赖 React state —— 长按方向键时每次 keydown 之间 React 未必已重渲染，
  用闭包里的 `view` 做自增会连续算出同一个值，表现为「按 5 次只前进 1 屏」。
- **连打不卡动画**：单次翻页保留 `.16s` 横向滑动；两次翻页间隔 < 200ms 时自动跳过动画直接落位
  （否则每次都从插值中途重启动画，页面会「追不上」按键）。换章一律直接落位。
- **点击热区**：单页时左右各 30%，双页时按中线二分。
- **滚轮**：向下滚翻下一页，向上滚翻上一页（流式阅读器与 PDF 阅读器一致）。

### 滚轮翻页的两个细节（2026-10-19 新增）

实现上踩了两个坑，都已固化为回归用例（`scripts/reader-wheel-check.mjs`，15 项）：

1. **必须手动 `addEventListener('wheel', fn, { passive: false })`，不能用 React 的 `onWheel`。**
   浏览器对 `wheel` 默认按 passive 处理，在合成事件里调 `preventDefault()` 会被忽略并告警，
   结果是页面跟着外层一起滚。自挂监听才能真正吃掉默认滚动。
2. **阈值 + 冷却要配套，且冷却期内要"整段丢弃"。**
   - 阈值 `FLOW_WHEEL_THRESHOLD = 100`：触控板会以 1~5 的极小 `deltaY` 高频连发，
     不设阈值一滑就跳十几页；鼠标滚轮一格通常是 100~120，正好"滚一格翻一页"。
   - 冷却 `FLOW_WHEEL_COOLDOWN_MS = 260`：滚轮的连发/惯性同理，冷却期内只认第一次。
   - 冷却期内**连累积一起清掉**而不是留着补翻 —— 留累积会让"一次大幅滚动后的残余事件"
     在冷却到期时再翻一页，表现为**滚一格翻两页**。（这条是测试先发现的。）

另外两条行为：**有文字选区时不翻页**（用户正在选字）、
`[data-dsh-scrollable]` 浮层内的滚动交给浮层自己处理（如笔记抽屉）。

### 进度模型：页码 + 百分比双锚点

页码在同一视口下精确，但换设备/改字号后会失效；百分比跨视口稳定但精度低。两者都存：

```text
章节书：v2;chapter=3;page=2;pct=41.5    （chapter 为章节序，page/pct 是章内位置）
文本类：v2;page=7;pct=58.2
PDF   ：v2;page=12;pct=57.1
```

恢复时**优先用页码**（同视口下就是上次那一屏），页码越界（重排导致页数变化）时按百分比换算。
旧锚点（`line:12` / `chapter:5` / `page:7`）仍能解析，降级为首页/对应单元，不报错。

### 封面

- **EPUB**：只认书里**声明式**的封面信号 —— `<meta name="cover">` → `properties="cover-image"` → id/href 含 `cover` 的图片项。
  明确**不做**「取 manifest 第一张图」这种猜测：那会把书里的插图当成封面，比没有封面更糟。
- **MOBI**：EXTH 201/202 封面偏移 + MOBI 头 First Image Index 定位图片记录；缺 EXTH 时扫 First Image Index 起始记录。
- **无封面**（文本类 / 未声明封面的书 / 提取失败）：客户端渲染**生成式封面** —— 按书名哈希取色相，
  同色系渐变 + 书名/作者排版。色相是「书籍内容色」而非 UI 语义色，因此用 HSL 字面量、不随明暗主题变化。
- 提取结果缓存在 `library/<id>/cover.<ext>` + `cover.json`（含「确认无封面」标记，避免反复解压重试）。
- `/cover` 对无封面**返回 404**（不是 500）：客户端据此渲染生成式封面。
- 老书目（`hasCover` 字段缺失）在首次列书架时**懒回填**并落盘，无需手动迁移。

### 阅读设置

`settings.reader = { fontSize, lineHeight, theme, columns, txtReflow, bookCss, fontFamily }` 经 Host 持久化（`/settings`），
改字号/版式**立即生效并落盘**，下次打开保持。`lastOpenedBookId` 记录上次打开的书，重启 GUI 后回到原书。

`txtReflow`（仅对 `.txt` 生效，工具栏上叫「换行」）：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 按段边界判据合并折行，段落重排（标准中文小说版式） |
| `preserve` | 不合并折行，源文件每个非空行独立成段（判据出问题时的退路） |

`bookCss`（仅对章节书 epub/mobi/web 生效，工具栏上叫「排版」）与 `fontFamily`（叫「字体」，全部文本格式生效）：

| 设置 | 值 | 行为 |
|---|---|---|
| `bookCss` | `book`（默认） | 取书内 CSS，作用域化后注入，**恢复原书排版层次** |
| | `unified` | 忽略书内 CSS，用阅读器统一排版（段首缩进 + 段距 + 图片居中） |
| `fontFamily` | `system`（默认） | 跟随 GUI 字体；书内 `font-family` 保留 |
| | `serif` / `sans` | 宋体 / 黑体；**会丢弃书内 `font-family`**（否则书内规则特异性更高，设置看起来"没反应"） |

老 `data.json` 没有这些字段时由 `normalizeReaderSettings` 收敛为默认值（`book` / `system`），**无需手动迁移**。

## EPUB 书内排版：为什么文字"全都一样"，以及怎么修（2026-10-20）

### 症状与根因

用户反馈：`进入 epub 后文字全都是一样的`（标题与正文无差别、段落无首行缩进）。

三层实测定位（不是推测）：

1. **书内样式在消毒环节被整体丢弃**。章节 HTML 里本来有
   `<link rel="stylesheet" href="../stylesheet.css">`，`rewriteChapterHtml` 已把它改写到 `/asset`，
   但随后 `sanitizeHtml`（DOMPurify）会把 `<link>` 与 `<style>` **整个删掉**：

   ```text
   NO   link 标签是否保留
   NO   style 标签是否保留
   YES  class 属性是否保留（calibre_1 / bold）
   ```

   这一步本身是**正确的安全行为**：注入 `<link>` 会让书内 `p` / `body` 规则全局生效，
   把设置面板、侧边栏一起改掉。所以缺陷不在消毒，而在「丢了之后没有别的通道把样式取回来」。

2. **标题根本没有语义标签**。calibre 转换的中文书把标题写成

   ```html
   <p class="calibre_1"><span class="calibre5"><span class="bold">02 周期的特征</span></span></p>
   ```

   层次完全由书内 CSS 表达（`.bold{font-weight:bold}`、`.calibre5{font-size:1.125em}`、
   `.calibre_1{text-align:center}`）。CSS 一丢，标题就退化成最普通的 `<p>`。

3. **全库普查**：23 本 epub 中，**0 本**每章都带 `h1~h6`；**7 本**完全没有任何语义标题；
   其余 16 本只有封面/书名页那 1~2 章有。→ 靠「给 h1~h6 补样式」覆盖不到正文。

### 修法

新增 Host 路由 `GET /styles?id=<bookId>` 把书内 CSS 取出来，客户端**作用域化 + 属性过滤**后注入：

```text
epub 解压目录 ──(Host 递归收集 *.css)──> /styles ──(Client: scopeBookCss)──> <style data-dsh-book-css>
                                                  每条选择器加 .dsh-reading-flow 前缀
                                                  只保留排版类属性
```

- `src/book-styles.ts`（Host）：扫 `library/<id>/**/*.css` 合并。不解析 OPF 清单——
  OPF 路径不固定（`content.opf` / `OEBPS/content.opf` 都有），而解压时整包已原样落盘，扫一遍更可靠。
  单文件 256KB、合计 1MB 上限，超限跳过并记 `warnings`。
- `src/client/book-css.ts`（Client）：纯函数 `scopeBookCss`，自带注释/字符串/嵌套感知的 CSS 切分。
- 降级纪律：`css` 为空串 = **这本书确实没有书内样式**（mobi / web / 无 CSS 的 epub），走统一美化；
  请求 reject 或解析抛错 = **显式提示**「本书样式加载失败，已按统一美化显示」+ `console.error`。
  绝不把失败当成功静默过去。

### 属性白名单（这是「不把排版搞坏」的关键）

保留：`font-family`（可关）、`font-size`（**仅相对单位**）、`font-weight`、`font-style`、`font-variant`、
`letter-spacing`、`word-spacing`、`text-align`、`text-indent`、`text-transform`、`text-decoration*`、
`vertical-align`、`white-space`、`word-break`、`overflow-wrap`、`hyphens`、`display`（仅 block/inline/inline-block）、
`margin*`、`padding*`、`list-style-*`。

刻意丢弃，每条都有原因：

| 丢弃 | 原因 |
|---|---|
| `line-height`、`font-size` 的绝对单位（`px`/`pt`） | 字号与行距是阅读设置的承诺，被书内固定值锁死后「改字号没反应」会变成查不出的 bug |
| `color` / `background-color` | 书里写死的黑字白底在暗色主题下直接不可读 |
| `position` / `width` / `height` / `float` / `overflow` / `column-*` / `break-*` / `display:none` | 布局类，与 CSS 多栏分页冲突；`break-inside: avoid` 会让长段落跨不了屏（TXT 分栏踩过同一个坑） |
| `@font-face` / `@import` / `@keyframes` / `@page` / `@media print` | 字体不该被书绑定；被引用的表会被 Host 单独收集；打印规则在屏幕上无意义 |
| `html` / `body` / `:root` 自身规则 | 这些元素在渲染 DOM 里不存在，硬挂到正文容器上会把 body 的边距语义错套上去 |

### 刻意不做的事

**不做「把居中 + 粗体 + 短行猜成标题」这类语义推断。** 判据无法保守：正文里的强调句、
引文落款、人名行都满足该特征，一旦误判就是错排版，属于典型的假阳性。只还原**书里明写的规则**。

### 已知限制

- 书内 CSS **没有**、且标题又是 `<p class=...>` 的书，在「统一美化」下仍无法还原标题层次
  （没有语义信息可用，只剩推断这条路，见上）。
- 相对字号（`1.125em`）叠加在用户字号之上：极端书内 CSS 可能排出与原书仍不完全一致的观感，
  用工具栏「排版」切到「统一美化」即可回到阅读器自己的版式。
- 书内 CSS 里的字体（`@font-face`）不加载，正文用系统字体；想改字体请用「字体」设置。

## EPUB 章节切分修正：为什么以前「一章没读完就跳下一章」（2026-10-30）

### 症状

用户反馈：读书时感觉**一章内容还没完，就直接到下一章去了**。

### 先排除内容丢失（三层实测，1084 章全过）

| 层 | 判据 | 结果 |
|---|---|---|
| 落盘 | 章节 HTML 与原 EPUB 内 xhtml **逐字节对比** | 缺失 0、不一致 0 |
| 渲染 | `rewriteChapterHtml → sanitizeHtml` 后**纯文本长度对比** | 变短 0 章 |
| 分页 | 真实浏览器多栏排版，`scrollWidth` 反推屏数 vs **块级 fragment 真值** | 少算屏 0、多算屏 0 |

> ⚠️ 排查中踩过的假阳性：用「行内文本片段（如 `<span>权）</span>`）的 rect.left」
> 反推列号会误判到右边一列（片段可能在行中间），据此一度误诊「65 章章末内容丢失」。
> 真实列数必须看**块级元素被多栏拆出的 fragment**（其左缘严格对齐列起点）。
> 复现脚本：工作区 `docs/diag-chapter-incomplete/probe-scrollwidth-truth.mjs`。

### 根因：spine 是文件清单，不是逻辑章节

实测《情绪流龙头战法》的 manifest：

```
 index  字数    旧目录标题
   9     12字    第一章 股市的起源和本质   ← 只有一个标题的 spine 文件
  10   2690字    chapter007             ← 真正正文是「第一节 股市的起源」
  11   9281字    第二节 股市的本质
```

旧实现按 spine **文件**切章，于是：点「第一章」只看到一屏标题，翻一页标题变成
`chapter007`（该文件在 `toc.ncx` 里没有条目，标题回退成了文件名）。用户感知就是
「第一章没读完就进第二章」。

### 修法（`chapterSplit = 2`）

`src/epub.ts` 的 `splitChapters`（纯函数，可自测）：

1. **纯标题页并入下一章**：可见文字 ≤ 60 字且没有长段落的 spine 页标记 `skip`，
   其 body 内容前置拼进下一章，写成同目录的 `<name>.merged.xhtml`
   （同目录 ⇒ 书内相对图片路径不变）。
2. **文件名标题回退**：`chapter007` 这类标题从正文 `h1~h3` 提取真实标题
   （只取 h1~h3：calibre 书里的 h4 常是正文小标题）。
3. **`index` 保持不变**：进度锚点 `chapter=N` 与划线锚点 `mark:ch=N` 都按数组下标定位，
   删项会让旧数据整体错位。所以标题页条目保留、只标 `skip`，由阅读器跳过。

老书库**不需要重新导入**：`readEpubManifest` 发现 manifest 没有 `chapterSplit` 时，
会用手上的 `book.epub` 就地重算一次（幂等）；失败写 `chapterSplit: 0` 避免反复解压重试。

阈值取舍：全库实测 1082 章里合并 68 个（6.3%）。阀值曾试 120 字，会把「标题 + 70~110 字
导语」的页并进下一章、导语变成正文开头，因此收紧到 60 字。

### 已知限制

- 无 `h1~h3`、首段又是长正文的章节（如 `chapter014_0001`）没有可提取的标题，仍显示文件名；
- 标题页合并后，原书「章 → 节」的层次只体现在正文顶部的标题上（目录仍是扁平列表）；
- 只处理 EPUB；mobi / web 书自己的 manifest 不带 `skip`。
- **旧划线锚点**：被合并的标题页若以前有划线（`mark:ch=N`，N 现为 skip），不再渲染。
  纯标题页通常没有正文可划，概率很低，但重算老书时这是已知行为。

### 阅读器侧配套（同次修复）

- 目录下拉**只列非 skip 章**；`unitList` / `unitCount` 保持全量，索引空间不变
  （`goChapter` 越界校验与 `overallPercent` 分母都依赖它）；
- **翻页与换章跳过 skip 章**：`findUnit(list, from, direction)` 沿方向找第一个非 skip 单元，
  找不到就保持原位（绝不越界）；章内链接指向 skip 章时按方向顺延；
- **章号显示用可见序号**（1..N），不用内部索引：否则跳过 skip 后会出现
  1、2、4、5 的跳号，用户会以为「又少了一章」；
- 初始恢复落到 skip 章时同样顺延（旧进度数据兼容）。

### 同时修掉的两个交互缺陷

| 缺陷 | 位置 | 触发 | 后果 |
|---|---|---|---|
| 加载期连按「下一页」跳过整章 | `ReaderView` 的 `goChapter` / `nextPage` | 上一章只有 1 屏，换章加载中再按一次；`pagination` 仍是上一章屏数 → `target(1) >= viewCount(1)` → `goChapter(+1)` | **整章被跳过** |
| 换章响应无代际校验 | `ReaderView` 的 `goChapter` 异步回调 | 快速换章、网页书按需抓取 1~4 秒时旧请求后到 | 旧章正文写到新章号下，读到 A 章、进度记 B 章 |

修法：换章时 `setPagination(INITIAL_PAGINATION)` + 正文未到达时翻页直接 return（不跨章/不累加）；
异步回调用 `chapterRequestRef` 代际号，token 不匹配整体丢弃（失败分支也不 `setError`）；
初始载入的首批章节请求共用同一代际号。

回归：`scripts/chapter-switch-check.mjs`（组件级，jsdom + 真实 ReaderView，22 项）——
M8 连按只前进一章、M9 旧响应不覆盖、skip 目录/翻页/章内链接顺延、章号连续显示；
脚本带**反证**（临时移除「加载期早退 + 分页复位」→ 用例 1 FAIL；移除 token → 用例 2 FAIL）。

## 分页重测失效：图片多的章节永远只有 1 页（2026-10-30 实测修复）

### 症状

用户在《情绪流龙头战法》「第十三节 龙头股的演进过程」**只看到 1 页**（进度记录 `chapter=37;page=0;pct=100`）。
该章实际有 1059 字 + **11 张插图**，双页视图下应是 7 列 ≈ 4 屏。

### 根因

`FlowReader` 的 ref 写法有两处错误叠加：

```tsx
// ❌ 旧写法
const flowRef = externalFlowRef ?? internalFlowRef;
useEffect(() => {
  if (externalFlowRef !== undefined) externalFlowRef.current = internalFlowRef.current; // 内部 ref 永远是 null
});
<div ref={flowRef}>…</div>
```

- `div` 的 ref 绑的是**外部** ref（`externalFlowRef`），内部 ref 从未绑定 DOM、恒为 `null`；
- 那个 `useEffect` 每个 passive effect 都把**外部** ref 覆盖成 `null`；
- `measureFlow()` 读 `flowRef.current` → 从第二帧起永远 early return；
- 于是**图片加载完成（`load` 捕获监听）、窗口缩放、字号变化后的重测全部失效**。

分页停在「首次测量时图片还没加载」的结果：文字只占 1 列 → 双页 1 屏。
纯文字章节首次测量就准确，所以这个 bug 平时看不出来；只有**图片多/加载慢**的章节才暴露。

### 修法

改用回调 ref，同时写内外 ref（外部 ref 仍供划线恢复用）：

```tsx
const attachFlow = useCallback((element) => {
  internalFlowRef.current = element;
  if (externalFlowRef !== undefined) externalFlowRef.current = element;
}, [externalFlowRef]);
<div ref={attachFlow}>…</div>
```

### 验证

`scripts/flow-ref-measure-check.mjs`（jsdom 挂载**真实 FlowReader**，7 项）：

- 外部 ref 必须指向 flow DOM（旧实现为 null）；
- 首测 1 屏 → 模拟图片加载（改 scrollWidth + 派发 `load`）→ 必须重测到 4 屏；
- 字号变化重渲染后 ref 仍有效且重测生效；
- 两条**源码防回潮断言**：不得再出现「外部 ref ← 内部 ref」的覆盖写法；
  `flow` 的 ref 必须是 `attachFlow`。

顺带修好的：窗口缩放、改字号之后分页现在会正确重算（以前会停在旧屏数）。

## 支持的格式

| 格式 | 解析位置 | 阅读方式 | 进度锚点 | 已知边界 |
|---|---|---|---|---|
| `.md` / `.markdown` | Host（**按字节判定编码**后原文入库） | marked 渲染 + DOMPurify | `v2;page;pct` | — |
| `.txt` | Host（**按字节判定编码**后原文入库） | **段落重排**（判定段边界、合并折行、每段一个 `p`；可切「保留原样」）；**切虚拟单元逐单元渲染** | `v2;chapter;page;pct` | 单元按章节标记或 ~2 万字切分；旧 `v2;page;pct` 锚点按百分比折算到单元；**重排后渲染文本 ≠ 原文，划线靠偏移映射换算**（见第 8 节本轮记录） |
| `.html` / `.htm` | Host（原文入库） | 消毒后直接注入 | `v2;page;pct` | 客户端按 txt 通道上传（当纯文本读） |
| `.epub` | **Host**（fflate 解压 + OPF/spine/ncx 解析） | 章节懒加载 + 章内分页 + **书内 CSS 作用域化注入**（见「EPUB 书内排版」节） | `v2;chapter;page;pct` | 图片走 `/asset`；嵌套目录层级压平；书内 CSS 只保留排版类属性 |
| `.mobi` | **Host**（PDB/MOBI 头 + PalmDOC LZ77 解压） | 单章 HTML 复用章节链路 | `v2;chapter;page;pct` | 仅 PalmDOC；HUFF/CDIC（AZW3/KF8）明确报错；不提取书内图片记录 |
| `.pdf` | Client（pdf.js 主线程 fake worker） | canvas 逐页渲染，支持单/双页与缩放 | `v2;page;pct` | 划线暂不支持 |
| **`web`（网页书源）** | **Host**（`ctx.web.fetch` 抓取 → 提段落纯文本 → 逐章落盘） | 复用章节链路（目录 + 按章懒加载） | `v2;chapter;page;pct` | 目前只支持 alicesw.tw；目录页会被抓取后端截断，靠章节链补齐；正文不保留原站任何标签与图片 |

设计原则：**重活放 Host**（解压、解析、封面提取），Client 只保留视图 —— 既避开 client seed 模块的体积约束，也让 `client-bundle-check` 这道闸门容易守住。

## 网页书源（2026-10-19）

在书架里填一个网页小说 URL，插件把作品抓下来存成**本地章节书**（`format: 'web'`），之后就是普通阅读。

调研背景与站点实测见工作区 `docs/web-source/`（可行性报告 + 抓取通道 + 站点解析规格三份）。

### 设计取舍（每条都有实测依据）

| 决策 | 理由 |
|---|---|
| **正文抓下来存成本地快照**，不做在线阅读直连 | 划线锚点是字符偏移、进度锚点是页码+百分比、读取链路只认 `library/` 副本；正文一旦在两次阅读之间变化，划线会**静默错位**（`mark-anchor.ts` 找不到就跳过不报错） |
| 落成**章节书**（`manifest.json` + 单章 HTML），照抄 mobi 形态 | `readEpubManifest` / `/content?chapter=n` / `safeZipPath` 路径防护 / `purgeBookFiles` **全部零改动复用**；1221 章若塞成单个 txt 会退化成全书偏移锚点 |
| 抓取放 **Host 侧 `ctx.web.fetch`** | 沙箱里 `fetch` 是 trap（调用即抛）；Client 半不能加第三方依赖，且跨域抓取受 CORS 限制 |
| 只存**段落纯文本**，重写成 `<p>` | 抓来的 HTML 原样入库会把注入面从客户端一个消毒点扩散到所有消费方（Agent 工具、未来的导出） |
| **不引 HTML 解析库** | 目标站正文容器内只有 `<p>`；字符串扫描足够，`jsdom` 更不可能进沙箱（依赖 node 内置与 `process`） |

### 抓取是「前端轮询驱动的分片」，不是后台循环

沙箱里 `setTimeout` / `setInterval` 都是 trap，写不出后台定时任务；1221 章 × ≥1.5s ≈ 30 分钟的抓取也不可能塞进一个 HTTP 请求。所以：

```text
POST /api/reading-workbench/sources/web         { url }              → 抓目录 + 建书 + 抓首章
POST /api/reading-workbench/sources/web/fetch   { bookId, count? }   → 按序抓 1~5 章（幂等，可中断）
GET  /api/reading-workbench/sources/web/status  ?id=<bookId>         → { total, fetched, pending, errors }
```

节奏由请求往返天然提供；`web.json` 记录 `fetched: number[]` 与各章源 URL，重进工作台可接着抓。

### 两个真实陷阱（都已固化进自测）

1. **目录页会被抓取后端截断**：`ctx.web.fetch` 的 `maxBodyChars` 默认 100,000 字符，而目标站目录页实测 **135,879 字符**（169,457 字节按 UTF-8 解码后）⇒ 尾部章节抓不到。
   解法是**目录懒扩展**：抓正文页时顺手取 `data-nurl`（下一章链接），抓完已知最后一章就把下一章追加进 `manifest.json`，如此顺链补到末章（`nextUrl` 为空）。截断时 `warnings` 会明确告知用户。
2. **真实页面 div 不配平**（实测 48 个 `<div` 对 45 个 `</div>`）：最初用「标签配平」划定正文范围，配平失败后回落到整页扫描，把导航/页脚的 `<p>` 当成正文（还骗过了 50 字阈值）。
   改为 `extractBodyParagraphs`：从正文容器起点**顺序吃掉连续 `<p>`**，遇到非 `<p>` 结构元素即停 —— 天然有界、不依赖配平。自测里有一条专门断言「正文里不能出现 `分類` / `最新章節` / `使用手機掃碼`」。

### 抓取通道：宿主不可用时自动回退到内置

抓取走两条通道，由插件配置 `webFetchMode` 选择：

| 取值 | 行为 |
|---|---|
| `host` | 只用宿主 `ctx.web.fetch`（带 SSRF 防护、地址固定等完整策略） |
| `builtin` | 只用插件内置的受限 HTTPS 抓取器（`src/web-fetch-fallback.ts`） |
| `auto`（默认） | 优先宿主；宿主通道不可用时**自动落到内置**，并把原因写进宿主日志 |

**为什么必须有内置通道**：`dsh-web` 默认同时注册两个抓取提供方（本地 `http` 与远端
`deepseek-fetch-api`），`fetchProvider` 一旦没有固定，每次调用都抛 `WEB_PROVIDER_AMBIGUOUS` ——
整个网页书源会不可用，而错误看起来还像站点问题。用户环境实测正是这种情况
（profile 里没有任何 `fetchProvider` 配置），光靠报错解决不了。

内置通道的**安全边界**（比宿主通道更窄，不是"绕过安全策略"）：

- 只允许 `https:`；
- 只允许书源适配器声明支持的域名（当前 `alicesw.tw` / `alicesw.com`）；
- 只跟随**同源**重定向，最多 3 跳；
- 响应体上限 8 MB、超时 30 s；
- 不发送 `Accept-Encoding`、不回传 cookie、不带任何凭据；
- 严格 UTF-8 解码，失败即报错（不把 U+FFFD 静默混进正文）。

准入检查都在发请求之前完成，因此可在离线自测里断言（非法 URL / 非 https / 白名单外域名 /
伪装子域 `alicesw.tw.evil.com` / 环回 / 内网地址，共 6 条）。

**顺带的好处**：内置通道不受 provider 的 100,000 字符上限约束，目标站目录页
（实测 135,879 字符）能**一次抓全 1221 章**，不再需要目录懒扩展兜底。
懒扩展仍然保留，因为 `webFetchMode=host` 时那条上限真实存在。

### 抓到哪读到哪：按需抓取（2026-10-19 用户实测反馈后新增）

**用户反馈**：抓了一本书，只有第 1 章能读；点第 2 章报 `加载失败: chapter file missing`，
而且「无法区分哪个章节已经下载」。

**根因（两层，都要修）**：

1. **设计缺陷**：抓取进度靠「书架面板的轮询循环」推进，而阅读是**并列的另一条路径** ——
   用户进阅读器、重启 GUI、或想直接读第 500 章，都会卡住。把「能不能读到内容」的前提押在
   「后台把前面所有章抓完」上是错的。
2. **反馈缺失**：`/content?chapter=n` 在文件缺失时只回一句 `chapter file missing`；
   `/sources/web/status` 只报「已抓 N 章」这种聚合值，**答不了「我想读的那一章抓了没有」**。

**修法**：

- **`GET /content?id=&chapter=n` 对网页书按需抓取**：该章文件不存在时，Host **同步抓取这一章**
  （1~4 秒）再返回正文；抓不到才报错（`502` + 中文可行动说明）。
  ⇒ 「点到哪章读哪章」，不再依赖后台进度。
- **`/sources/web/status` 新增 `fetchedIndexes: number[]`**：阅读器的章节目录据此**逐章标记**
  已下载 / 未下载。
- 轮询续抓保留，但它降级为**后台补齐**（离线阅读、批量下载），不再是「能不能读」的前提。

**为什么这件事函数层测试抓不到**：`web-source-selftest` 覆盖适配器与编排，全绿；
问题出在**路由面**（`/content` 的缺失分支）与**跨路径的时序假设**上。
因此新增路由级套件 `web-source-instance-check.mjs`：把 `makeRoutes` 挂到真实
`node:http` 服务上，用真实 HTTP 往返验证建书 / 状态 / 按需抓取 / 续抓 / 错误码（28 项）。

### 失败纪律（对齐「审核不能有假阳性」）

- 抓取失败的错误码**逐条翻成中文可行动提示**（含内置通道的 9 个 code），不是抛原始英文；
- 正文段落 < 1 或总字数 < 50 → **抛错并附 URL**，绝不静默存回一章空正文；
- 建书时首章抓取失败 → **回滚**（删书目与目录），书架上不会出现打不开的空书；
- 抓取通道完全不可用（宿主无 `ctx.web` 且配置为 `host`）→ 网页书源路由回 **501 并说明「书架/导入/阅读不受影响」**，其余功能照常（`fiberPhase` 仍是 active）；
- 单章失败 → 进 `web.json` 的 `errors`（章序 + URL + 中文原因），不阻断其他章。

### 已知限制

- **只支持 alicesw.tw**（`SiteAdapter` 已是注册表形式，加站点只需新增一个适配器）。`xchina.co` 不可用：直连 TCP 超时 + 经代理遇 Cloudflare JS 挑战。
- **目录页可能被宿主抓取后端截断**（provider 上限 100,000 字符 vs 目录页 135,879 字符）。建书时若检测到截断，会自动改用插件内置通道（无字符上限）**重抓一次完整目录**并写进 `warnings`；只有补充抓取也失败时才按已知章数建书，剩余部分靠目录懒扩展补齐。
- **未抓的章节点开会自动抓取**（1~4 秒），阅读器章节目录逐章标记 `✓ 已下载` / `↓ 未下载`；后台续抓只负责批量补齐，**不再是「能不能读」的前提**。
- 不保存原站图片/插图；不保留内联强调。
- 重新抓取会让旧划线失配，首版**不提供整本覆盖式重抓**（只按序补抓缺失章）。
- 站点改版会让选择器失效 —— 此时表现为「解析失败」并报错，不会抓到错误内容。

### 验证

```powershell
node scripts/web-source-selftest.mjs       # 66 项：HTML 工具 / 适配器（真实样本 1221 章）/ 反证 / 内置通道准入 / 抓取编排（幂等、目录懒扩展、失败不阻断）
node scripts/web-source-live-check.mjs --live   # 16 项：**真实访问站点**，验证「目录截断 → 懒扩展」在真实网络下接得上（5 次请求、1.5s/章）
```

`web-source-selftest.mjs` **不依赖网络**（适配器吃 `docs/web-source/samples/` 的真实落盘样本，编排用假抓取函数），已接入 `pnpm check`。
`web-source-live-check.mjs` 需要显式 `--live` 才跑，避免在 CI 里打站点。

### 本次踩到并修掉的第三类沙箱事故：可选服务不能写进 `inject`

第一版按「服务必须 inject」的既有纪律写了 `inject: ['webServer','tools','web']`，构建时沙箱契约自测立刻炸：

```text
FAIL  修复后 Host 半 fiber 为 ACTIVE  state=0      ← 既不是 ACTIVE(2) 也不是 FAILED(3)
FAIL  修复后 REST 路由注册成功  routes=0
```

`state=0` 是 **pending**：cordis 对「inject 声明了、但当前没有任何插件提供」的服务，
会把 fiber 挂起等提供者，于是 **17 条路由一条都不注册** —— 用户看到的是「整个阅读工作台 404」，
而测试环境恰好没装配 `dsh-web`，正好命中。

修法：`web` 改用 `ctx.get('web')` 取（宿主 sandboxContext 显式放行 `get` 且不校验 inject），
取不到就只少网页书源。同时给沙箱契约套件补了一条断言把该决定钉死：
**`web` 不得出现在 `inject` 里**。

> 教训归纳：`inject` 只写**必需**服务（没有它整个插件就不该工作）；
> 可选能力一律 `ctx.get` + 显式 try/catch。这两类失败模式的后果差着数量级。

## 验证脚本（都可重复运行）

```powershell
$env:Path = "C:\Users\lihua\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:Path
cd D:\work\workspace\dsh-plugin\plugins\reading-workbench
node scripts/real-instance-check.mjs    # 真实实例验收 32/32（自动清理测试数据；Host 半改动需先重启 DSH）
node scripts/make-samples.mjs           # 生成 GUI 手工验收用的 sample.epub / .mobi / .pdf（含真实封面）
node scripts/tools-selftest.mjs          # Agent 工具：注册形态/schema 编译/execute/render 全链路
node scripts/mark-selftest.mjs          # 划线：锚点编解码 + jsdom 真选区/高亮恢复
node scripts/paginate-selftest.mjs      # 分页/锚点纯函数（单双页判定、屏数、屏宽 vs 步长、进度恢复、旧锚点兼容）
node scripts/paging-align-check.mjs     # **真实浏览器**：每屏左缘必须对齐列起点（防累积偏移）
node scripts/reader-keyboard-check.mjs  # **组件级**：挂载真实 ReaderView + 真实 keydown，验证连发不丢步
node scripts/pagination-browser-check.mjs # **真实浏览器**验证多栏几何（headless Chrome/Edge；无浏览器则跳过）
node scripts/panel-height-check.mjs     # **真实浏览器**验证面板高度链（防 100% 塌陷导致空白面板）
node scripts/migration-selftest.mjs     # **老数据迁移**：用真实 data.json 结构验证设置/封面/旧锚点兼容
node scripts/bundle-feature-check.mjs   # 交付产物特性核对（UI v2 类名/锚点/路由是否真在 lib/client.cjs 里）
node scripts/cover-selftest.mjs         # 封面链路：EPUB(meta/properties)/MOBI(EXTH) → /cover → 字节一致
node scripts/ui-render-check.mjs        # **UI 渲染冒烟**：jsdom + react-dom/server 真渲染书架与阅读器
node scripts/chapter-html-check.mjs     # 章节资源路径归一化与链接重写
node scripts/chapter-split-selftest.mjs # **章节切分**：纯标题页并入下一章 + 文件名标题回退（含反证，已接进 pnpm check）
node scripts/chapter-switch-check.mjs   # **组件级换章导航**：加载期连按跳章 / 乱序响应覆盖 / skip 跳过 / 章号连续（22 项，已接进 pnpm check）
node scripts/epub-selftest.mjs          # EPUB：构造最小合法 EPUB 走全链路（含路径穿越防护）
node scripts/mobi-selftest.mjs          # MOBI：PalmDOC 解压单元用例 + 手工构造 MOBI 全链路
node scripts/pdf-selftest.mjs           # PDF：构造最小 PDF 验证 /file 原始字节一致
node scripts/fence-selftest.mjs         # 围栏逻辑自测（不依赖 DSH，加载 lib 产物起临时服务）
node scripts/host-upload-selftest.mjs   # 上传导入 + **阅读设置**（默认值/落盘/越界收敛/部分更新）自测
node scripts/encoding-selftest.mjs      # **编码判定与 txt 虚拟单元**：BOM/UTF-8/GBK 表驱动、损坏判据、切分偏移契约
node scripts/txt-layout-selftest.mjs    # **TXT 段落重排**：段边界判据、双向偏移映射、代理对、兜底切段（193 项，已接进 pnpm check）
node scripts/web-source-selftest.mjs    # **网页书源**：HTML 工具 / alicesw 适配器（真实样本）/ 反证 / 内置通道准入 / 抓取编排（66 项，已接进 pnpm check，不依赖网络）
node scripts/web-source-live-check.mjs --live  # **网页书源真实站点验收**：目录截断 → 懒扩展能否接上（16 项，需显式 --live，会真的打站点）
node scripts/txt-reflow-check.mjs       # **TXT 重排独立对抗验收**：真实书回放 + jsdom DOM 级对拍 + 边界/性能（1817 项；需本机书库，见下）
node scripts/txt-reflow-browser-check.mjs # **真实浏览器**排版几何：段间距/首行缩进/按容器宽度重排/分栏（无浏览器则跳过）
node scripts/markdown-check.mjs         # Markdown 渲染 + 消毒管线（jsdom 真 DOM）
node scripts/book-css-selftest.mjs      # **书内 CSS 作用域化**：解析器骨架 / 选择器作用域化 / 属性白名单反向断言 / 真实书回归（已接进 pnpm check）
node scripts/book-styles-selftest.mjs   # **书内 CSS 收集（Host）**：临时目录构造 epub 布局，判据是「路径必须是相对书根的」（已接进 pnpm check）
node scripts/epub-style-pipeline-check.mjs # **链路前提**：断言 sanitize 会剥掉 link/style、保留 class —— 书内 CSS 只能走 /styles（已接进 pnpm check）
node scripts/styles-instance-check.mjs  # **端到端**：加载 lib 产物起本地服务，真实书走 /styles → 作用域化 → 断言标题加粗/缩进真的进了产物（需真实书库，无则 SKIP；已接进 pnpm check）
node scripts/client-bundle-check.mjs    # Client 产物验收：信封形态 + require 只命中平台 seed 模块
node scripts/fence-check.mjs            # 对运行中的 DSH 实例跑围栏回归
```

> `scripts/real-instance-check.mjs` 会先探活新路由：若运行中的实例还是**旧版 Host 半**
> （`/settings` 未注册、网关返回 401），脚本直接给出「请重启 DSH」的结论并以 exit 2 退出，
> 而不是让后续断言连环失败。这是 Host 半改动必须重启的直接体现。

## 1. 定位

在 DSH Web GUI 内提供沉浸式阅读工作台：书架管理、Markdown/TXT 阅读、划线批注，
并通过 Agent 工具与「阅读助手」预设把读书内容接入 DSH 对话闭环。

导入方式：**文件选择器（可多选）+ 拖拽到书架**。浏览器拿不到本地绝对路径，
因此前端读文件内容后经 `/books/upload` 交给 Host 落库（另有按绝对路径导入的 API 通道备用）。

阅读渲染：Markdown 经 marked 转 HTML、DOMPurify 消毒后注入（脚本/事件属性/`javascript:` 全部清除）；
TXT 保留纯文本换行。排版样式全部走主题 token（标题/列表/引用/代码/表格/链接/图片/分隔线）。

非目标（本插件不做）：PDF/EPUB 渲染（二期评估）、团队共享、云端同步。

## 2. 挂载点清单（全部 additive，无 shipped-UI 覆盖）

| 挂载点 | 平台 | 用途 |
|---|---|---|
| `sidebar.panellist` | client | 侧边栏「阅读」入口图标 |
| `main`（key: `reading`） | client | 一级主面板：书架 / 阅读器 / 笔记 |
| Host 路由 `/api/reading-workbench/*` | host | 书目 / 进度 / 划线 / 书籍内容的 REST 面 |
| Host 工具 `reading_workbench_*` | host | Agent 侧书目检索、划线搜索、开书 |

说明：`main` 槽位本身标 `replaceRisk: shadows-shipped-ui`，但 keyed 机制按 key 分发，
自定义 key 属于 additive 用法；`sidebar.panellist` 为 `replaceRisk: none`。

> **设计边界（2026-10-20 用户决定）**：本插件**只读书**，不提供任何会话域 UI。
> 曾经挂载过的两个会话域槽位都已移除，且 `client-assembly-check` 用反向断言防止回潮：
> - `conversation.composer.dock`（在会话输入框下方「插入书摘」）；
> - `conversation.view`（把阅读器做成会话内 tab）。
>
> 两者的失败原因记在 README 第 10.2、11 节，供以后判断「要不要再试」时有据可依。

## 3. 数据模型（本插件私有 HTTP 面，schema 版本 1）

```text
books      { id, title, author?, sourcePath, format, addedAt, hasCover? }
progress   { bookId -> { anchor, percent, updatedAt } }     # anchor 为 v2 双锚点串
highlights { id, bookId, text, note?, anchor, createdAt }
settings   { lastOpenedBookId?, reader: { fontSize, lineHeight, theme, columns } }
```

- 主存储：插件私有 JSON 文件（`data.json`），**不做**内存全量缓存，
  每次 API 调用现读现写，避免与热重载和外部编辑冲突。
- `anchor` 是 v2 定位串，格式见上文「进度模型」。旧格式（`line:` / `chapter:` / `page:`）读取时兼容。
- `columns` 取值 `1 | 2 | 'auto'`；`fontSize` 收敛到 13–28，`lineHeight` 收敛到 1.3–2.6（非法值回落默认）。
- `hasCover` 为 `UI v2` 新增；老数据在首次列书架时懒回填。
- 跨插件共享（M2 后）：提供只读 REST 子集；不暴露写接口。

## 4. Host / Client 接口契约

REST（统一响应 `{ ok: true, data }` / `{ ok: false, error }`，全部走 loopback 同源）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/reading-workbench/health` | GET | 健康检查 |
| `/api/reading-workbench/books` | GET | 书目列表（内嵌进度与划线数；顺带回填封面标记） |
| `/api/reading-workbench/books` | POST | 按本地绝对路径导入（Host 读文件复制进书库） |
| `/api/reading-workbench/books/upload` | POST | **按内容导入**（浏览器文件选择器/拖拽通道，文本类） |
| `/api/reading-workbench/books/upload-binary` | POST | **原始字节流上传**（epub/mobi/pdf；query 传 title/format，上限 128MB） |
| `/api/reading-workbench/books/remove` | POST | 移除书目（不删原文件；**顺带清理书库副本与解压产物**） |
| `/api/reading-workbench/content` | GET | 取正文（`?id=`；章节书带 `?chapter=n`） |
| `/api/reading-workbench/toc` | GET | 章节目录（`?id=`） |
| `/api/reading-workbench/asset` | GET | 书内资源（`?bookId=&path=`，路径穿越受防护） |
| `/api/reading-workbench/cover` | GET | **封面图**（`?id=`；无封面返回 404） |
| `/api/reading-workbench/file` | GET | 原始书籍字节（pdf.js 用） |
| `/api/reading-workbench/settings` | GET / PUT | **阅读设置与最近打开**（PUT 部分更新） |
| `/api/reading-workbench/progress` | PUT | 保存进度（body 带 bookId/anchor/percent） |
| `/api/reading-workbench/highlights` | GET / POST | 划线列表（`?bookId=`）/ 创建 |
| `/api/reading-workbench/highlight` | DELETE | 删除划线（`?id=`） |

全部为 exact 路由（对齐 skill-explorer 实证形态，不使用路径参数）；
JSON 请求体上限 16MB，二进制上传上限 128MB。

Client → Host：UI 一律经同源 `fetch` 访问上述路由（对齐 skill-explorer 的 SkillApi 形态）。
**非 JSON 响应要给出可行动的提示**：DSH 网关对未注册路由返回 401 文本，
若直接 `response.json()` 会抛 `Unexpected token 'o'`，因此统一先取文本再尝试解析。

## 5. 目录结构

```text
plugins/reading-workbench/
  package.json            # manifest：dsh.bundle.patch + dsh.client.inject/platform
  cordis.patch.yml        # - insert: [{ id: reading-workbench, name: dsh-reading-workbench }]
  tsdown.config.ts        # 双入口构建：lib/index.mjs（ESM/Host）+ lib/client.cjs（ModuleLoader 信封 CJS/Client）
  tsconfig.json / tsconfig.build.json
  src/
    index.ts              # Host 半入口：name/inject/apply
    store.ts              # data.json 读写与校验、设置规整、书库清理
    http.ts               # exact 路由族（loopback 围栏）
    epub.ts               # EPUB 解压、OPF/spine/ncx 解析、包内路径归一化
    mobi.ts               # PDB/MOBI 头解析 + PalmDOC 解压
    cover.ts              # 封面提取（EPUB 声明式 / MOBI EXTH）与缓存
    shared/
      types.ts            # Host/Client 共享类型、路由字面量
      anchor.ts           # 进度锚点编解码（纯函数，两侧共用）
    client/
      index.tsx           # Client 半入口：apply(ctx) + slots.inject 注册
      api.ts              # document-relative fetch 封装
      styles.ts           # 全部样式（选择器加 dsh-reading- 前缀）
      markdown.ts         # marked + DOMPurify
      chapter-html.ts     # 章节资源路径归一化与链接重写
      paginate.ts         # 分页算术（列数/屏数/百分比换算，纯函数）
      panel/
        WorkbenchPage.tsx # 书架 ⇄ 阅读器 两态切换
        ShelfView.tsx     # 书架：封面网格 / 搜索 / 排序 / 导入 / 移除
        ReaderView.tsx    # 阅读器：工具条 + 分页正文 + 状态条 + 进度
        FlowReader.tsx    # CSS 多栏分页容器（测量与平移）
        PdfViewer.tsx     # PDF：canvas 渲染，单/双页与缩放
      locales.ts          # zh / en 词典
  lib/                    # 构建产物（gitignore）
```

## 6. 里程碑

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| M0 | 骨架 + manifest + 安装进 desktop profile | 插件条目出现、`/health` 200、侧边栏入口与 `main` 面板出现 | ✅ |
| M1 | 书架 + 阅读 + 进度 + 划线 | 真实 GUI 全流程可用 | ✅（划线见 M3） |
| M1.5 | **UI v2**：书架封面网格 + 单/双页分页阅读器 + 设置持久化 | GUI 视觉确认（翻页修复后待复验） | 基本完成 |
| M3 | 划线交互（正文选区 → 划线 → 笔记栏） | GUI 内可划线并持久化 | ✅ 代码完成，真实验收待重启 |
| M2 | Agent 工具 + 阅读助手预设 + 插入书摘 | 工具出现在 `Tool.listTools`，会话内可引用划线 | ✅（2026-10-20 补齐预设与书摘插入） |

## 7. 已知限制与待办

### 待办
- **重启 DSH 后确认 EPUB 书内排版生效**（2026-10-20）：`/styles` 路由是 Host 半新增的，
  本地自测已全绿（`book-styles-selftest` 12 项 / `book-css-selftest` 34 项 / `epub-style-pipeline-check` 9 项），
  但 GUI 内的实际观感需在重启后确认：打开《周期》第 7 章，标题应居中加粗且比正文略大。
- **Agent 工具的运行时复核**：本会话的 inspect 通道损坏（所有输入被拒），
  重启后用 `Tool.listTools` 确认 `reading_books` / `reading_highlights` / `reading_excerpt` 出现且 schema 正确。
- **「阅读助手」预设与书摘插入的 GUI 复核**（2026-10-20）：两项都是**新增能力**，
  自测覆盖到「定义形状 / 降级纪律 / 只写不发送」，但真机观感需重启后在 GUI 确认：
  输入框下方应出现「插入书摘」按钮；预设列表里应出现「阅读助手」。
  Host 半改动需重启 DSH 才生效（Node ESM 模块缓存）。
- `scripts/e2e-check.mjs` 是 v1 的端到端脚本，进度锚点断言仍是旧格式，**尚未更新到 v2**；
  v2 的实例级验收以 `real-instance-check.mjs` 为准。

### 限制
- **Client 半禁止留第三方 `require`**：DSH 的 client 模块表只认 9 个平台 seed 模块
  （`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`），
  其余一律不在表内。产物里残留 `require("第三方包")` 会让**整个 web boot 失败、GUI 起不来**
  （弹「应用无法启动」），而不只是本插件缺席。因此 `dompurify` / `marked` / `pdfjs-dist` 已由
  `tsdown.config.ts` 的 `deps.alwaysBundle` 打进 bundle，并挪进 `devDependencies`
  （运行时不需要 npm 安装）；`pnpm build` 末尾的 `client-bundle-check.mjs` 负责在交付前拦住构建漂移。
- 分页依赖 `ResizeObserver` 与 CSS 多栏（`column-fill: auto`）：现代 Chromium / Firefox / Safari 均支持。
  极窄窗口下单页列宽下限 120px，排版会挤压但不会崩。
- MOBI v1 只支持 PalmDOC 压缩，**不提取书内图片记录**（产物是纯正文 HTML）。
- EPUB 嵌套目录被压平为一层（toc.ncx 的 navPoint 按扁平处理）。
- **EPUB 书内 CSS 只保留排版类属性**（白名单见「EPUB 书内排版」节），布局类与颜色一律丢弃；
  书内字体（`@font-face`）不加载。标题若在书里只是带 class 的 `<p>` 且书内无 CSS，
  在「统一美化」下无法还原层次（不做语义推断，避免假阳性）。
- **宿主沙箱的写权限只覆盖工作区根目录**（2026-10-20 实测）：`pwsh` 子进程对
  `plugins/` 及以下目录创建文件/目录会 EPERM，`tsc -b` 写 `lib/` 与
  `reader-wheel-check.mjs` 建 `node_modules/.cache` 都会失败；构建与这几项自检需在
  完全权限（full access）下执行。DSH 自身的文件工具不受影响（可正常写源码）。
- PDF 用主线程 fake worker 渲染（无独立 worker 文件），超大 PDF 会占用主线程。
- 数据落盘：`~/.dsh/reading-workbench/data.json`（书目/进度/划线/设置）+ `library/`（导入副本 + 解压产物 + 封面缓存）。
- **本机构建环境**：系统 PATH 的 node 14 不可用，构建前把 DSH 自带 node 24（`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin`）放到 PATH 最前（详见 runtime-notes 第 10 节第 1 条）。
- **Host 半改动需重启 DSH**：disable/enable 不会重载已缓存的 ESM 模块（runtime-notes 第 10 节第 9 条）。
  本轮 UI v2 新增了 `/cover` 与 `/settings`，因此**必须重启 DSH** 后 `/cover`、`/settings` 才存在。
- `sidebar.right.*` 文档页签族：本插件 M0–M1 不依赖；若 M2 之后需要右侧伴随阅读，
  先用 `Slots.listSubTree({ root: "sidebar.right.pane.tab" })` 定向补查再设计。
- 主题 token 须明暗两值（见 `docs/dsh-runtime-notes.md` 第 6 节）；locale 词典注册 NS 用 `dsh-reading-workbench`。
- Client 半 React 经 peer 依赖提供，构建走 jsx-runtime，产物为 ModuleLoader 信封 CJS（见 `agents.md` 第 6.4 节）。
- **生成式封面的色相是唯一的硬编码颜色**：它是书籍内容色（按书名哈希），不是 UI 语义色，
  故不随明暗主题切换；其余颜色全部走主题 token。

## 8. 本轮改动记录（UI v2，2026-10-16）

| 类别 | 改动 |
|---|---|
| 交互 | 进入工作台先见**书架**；点书才进入阅读；阅读态整屏沉浸，工具条独占一行 |
| 书架 | 2:3 封面网格（真实封面 / 生成式封面）、进度条、格式徽标、搜索、排序、悬停显移除、空态引导 |
| 阅读 | **CSS 多栏分页**：单页 / 双页 / 自适应；左右点击热区、↑↓←→、空格、PgUp/PgDn、Home/End、Esc 返回 |
| 章节书 | 章末「下一页」自动进下一章；章首「上一页」回上一章**末屏**；章节下拉直达 |
| PDF | 支持单/双页并排（双页以跨页对翻页）、缩放、键盘翻页、进度回传 |
| 设置 | `columns` 新增；字号/版式即时生效并经 `/settings` 持久化；`lastOpenedBookId` 重启后回到原书 |
| 进度 | 新 v2 双锚点（页码 + 百分比）；旧锚点兼容 |
| 封面 | 新增 `/cover` 路由与 `cover.ts` 提取（EPUB 声明式 / MOBI EXTH）；老书目懒回填 |
| 移除 | 移除书目时顺带清理书库副本、解压产物与封面缓存（原文件仍不动） |
| 错误提示 | `/cover` 等路由对网关 401 给出「插件路由未注册，重启 DSH 后生效」的可行动提示 |
| 测试 | 新增 8 套共 238 项：`paginate-selftest`(55) / `paging-align-check`(40) / `reader-keyboard-check`(10) / `cover-selftest`(22) / `migration-selftest`(25) / `ui-render-check`(39) / `pagination-browser-check`(43) / `panel-height-check`(11) |

### 老数据兼容（无需手动迁移）

UI v2 给存储加了两个字段，老 `data.json`（v1）可直接用，**读取路径不写用户文件**：

| v1 缺什么 | v2 怎么处理 |
|---|---|
| `settings.reader.columns` | `loadData` 时规整补 `'auto'`；字号/行高/主题原值保留（越界才收敛） |
| `book.hasCover` | 首次列书架时**懒回填**并落盘（epub/mobi 真探测，其余记 false） |
| 进度锚点 `line:` / `chapter:` / `page:` | `parseAnchor` 兼容解析（新写入一律 v2 格式） |

已用用户真实 `data.json`（6 本书、`line:3:0` 旧锚点、v1 设置）验证：数量不变、id 不变、原文件零改动。

### 用户反馈修复：按键盘下一页时页面切换不准确（2026-10-16 第一次反馈）

用户截图显示双页模式下左右两栏内容错位、左侧露白。定位到**两个独立成因**，都已修复：

| # | 问题 | 现象 | 修法 |
|---|---|---|---|
| 5 | **翻页步长算错：把「一屏可见宽度」当成「跨屏距离」** | 两者相差一个列间距（48px），每翻一屏累积偏移：第 1 屏偏 48px、第 2 屏偏 96px → 左侧露出上一列尾巴、右侧正文被切 | 抽出 `screenWidthOf`（flow 宽）与 `stepOf`（翻页步长）两个语义清晰的函数；`viewOffset` 一律走 `stepOf`，组件不再自己算 |
| 6 | **翻页计数用闭包里的旧 `view`** | 长按/连发方向键时，两次 keydown 之间 React 未重渲染，连续几次 `setView(view + 1)` 算出同一个值 → **按 5 次只前进 1 屏** | 引入同步推进的 `targetViewRef`：事件处理里先推目标值再 `setView`，与 React 渲染节奏解耦；所有跳屏统一走 `jumpTo` |
| 7 | 连打时每次按键都重启滑动动画 | `.16s` 过渡被反复打断，页面「追不上」按键，观感同样是不准 | 两次翻页间隔 < 200ms 时给 flow 打 `data-instant` 直接落位；换章也直接落位 |

**这次修复暴露了测试方法的问题**，值得记住：

- 原来的 `pagination-browser-check` 只断言「transform 生效」——它用**同一个错误公式**推算期望值，
  所以「自洽地错」，42 项全绿却漏掉了 48px 的累积偏移。
- 修正后的 `paging-align-check` 改成**用浏览器实测的列起点**做判据（不引用产品公式）：
  每屏左缘必须压在某列起点上（实测 26/26 全部 0px 偏差），并附**反证断言**
  ——若用 `screenWidth` 当步长必须偏出 48px，确保这个测试真的能抓到该 bug。
- 新增的 `reader-keyboard-check` 不模拟逻辑，而是**挂载真实 ReaderView 组件**、
  派发真实 `keydown`、读真实 DOM 页码断言；并已做过**反证实验**：
  把 `nextPage` 换回闭包计数后，该测试立刻失败并给出「1 → 2（期望 6）」，
  与用户描述的症状一致，证明测试有效而非空转。

### 本轮自查发现并修掉的真 bug

| # | 问题 | 现象 | 修法 |
|---|---|---|---|
| 1 | **点击热区挂在被平移的内层元素上** | 翻到第 2 屏后 `getBoundingClientRect().left` 变成负值，点左侧三分之一也算「右侧」→ **只能往后翻、不能往前翻** | 点击监听到**未平移**的外层视口，热区按内容盒（扣掉左右内边距）计算 |
| 2 | **双页模式下热区仍是 30% / 40% 空白带** | 双页时点中间 40% 毫无反应，与「点左边回看、点右边继续」的直觉不符 | 双页按中线二分 |
| 3 | **EPUB 封面回落策略过宽**：「取 manifest 里第一张图」 | 书里第一张图往往是插图/示意图，会被当成封面显示 —— **比没有封面更糟** | 只认声明式线索（`meta name="cover"` / `properties="cover-image"` / id·href 含 cover），其余一律回落生成式封面 |
| 4 | **两套进度恢复刻度不一致** | `anchor.ts` 的 `restorePage` 用 `pct/100*pageCount`，`paginate.ts` 的 `restoreView` 用 `pct/100*(count-1)` —— 同一百分比换算出不同页 | 统一刻度，并加**一致性交叉断言**（count 2..12 × pct 5 档全比对）钉住 |

第 1、2 条属于「纯函数测试测不出、只有真渲染/真浏览器才能发现」的类别；
第 5、6 条更进一步：**需要真实交互序列 + 独立判据**才能发现。
因此验证分层补成四层：真渲染组件（`ui-render-check`）、真浏览器几何（`pagination-browser-check`、
`paging-align-check`、`panel-height-check`）、真组件 + 真事件（`reader-keyboard-check`）。

## 9. 本轮改动记录（TXT 段落重排，2026-10-19）

### 问题与根因

用户反馈「txt 全部显示到一起很难看」。根因是**两层叠加**：TXT 走
`<pre class="dsh-reading-plain">` + `white-space: pre-wrap`，源文件换行被原样保留 ——
老 txt 常见「每行 35~50 字硬折行」（折在句子中间，与阅读器列宽还不一致时会二次折行），
新 txt 常见「一段一行」（`pre` 里行间只有行高，**没有段间距与首行缩进** → 满屏文字墙）。

### 判据（全库 83 本真实 txt 回放验证，双峰无灰区：80% vs 0%）

**核心是「句子有没有说完」，不是行长统计**。反例：`我和我的妹妹雯雯.txt` 行长几乎恒为
34 字（看着像折行），但每行行尾都是 `。`，实际是短段落 —— 按行长统计会误判。
完整判据表与两条踩坑细节（行尾空白必须先 trim；右引号不能简单塞进标点集合）见
`docs/txt-reflow-design.md` 第 3 节。

### 偏移契约（本次最大的坑）

划线锚点是**全书字符偏移**，而 `collectFlowText()` 拼接 DOM 文本节点得到的偏移隐含
「DOM 文本 == 原文切片」这一前提。一旦渲染时删掉折行符，所有划线与「定位」会
**静默整体错位**（不报错，最难查）。

解法：`layoutTxt` 返回 `removedPositions`（被删字符在原文中的位置，升序），
配 `fullToRender` / `renderToFull` 双向二分映射。**锚点语义不变，旧划线零迁移**。

### 本轮修掉的真缺陷

| # | 问题 | 现象 | 修法 |
|---|---|---|---|
| 1 | **`」` 不在句末标点集合** | 中文对白 `「我等你。」` 与 `「好。」` 被判成折行 → 两句对白粘连；`我和我的妹妹雯雯.txt` 原本 89 次合并里 **81 次**源于此 | 右引号家族只在**引号前一字符也是句末标点**时才判段边界（`，」` 仍合并）；另加「下一行以 `「` 开头 → 段边界」 |
| 2 | **兜底切段劈开代理对** | `'甲' + '𠀀'.repeat(401)` 的 800 字硬切落在码元对中间，一个字符被切进两个 `p` | 硬切前判断高代理项，**提前一个码元切**（段长 799，仍守住 ≤800 约束） |
| 3 | `unitTextLength` 依赖已变成 HTML 的 `plainText` | `isStaleMark` 用含标签的长度判断，划线越界误判 | TXT 分支改用原文单元长度 |
| 4 | `jumpToMark` 落位比例量纲不一致 | 原文偏移直接除以渲染文本长度 | 先 `fullToRender` 再算比例 |

缺陷 1 由实现方与独立验证者**各自独立发现**（量化误差一致）；缺陷 2 由独立验证者用
1789 条断言抓出（当时 2 条失败，同一根因）。

### 验证证据（四层，全部可复跑）

| 层 | 脚本 | 结果 |
|---|---|---|
| 纯函数 | `txt-layout-selftest.mjs` | **193 项全绿**（含代理对反证：旧算法必须 FAIL，证明防护不是空转） |
| 独立对抗 | `txt-reflow-check.mjs` | **1817 项全绿**；6 本真实书合并数**逐本等于独立复算**；**7342 个行对零分歧**（排除聚合数相等的假绿）；DOM 对拍 58 个真实单元全等；全库 `\r` 58445 个**漏记 0 个** |
| 真实浏览器 | `txt-reflow-browser-check.mjs` | **18 项全绿**；**同一段窄容器 13 行 > 宽容器 8 行**（决定性证明按容器宽度重排、不是保留源文件换行）；缩进 2em、段间距 0.55em、`break-inside: auto` 实测 |
| 端到端映射 | T2 映射闭环（临时脚本，未入库） | 68 项；跨段选区**原文 24 字 ≠ 渲染 20 字**，直接证明长度必须端点相减，另含三条反证 |

性能：3.6 万字单元 auto 单次约 0.4~2ms（约束 < 30ms）；整本 55 万字全链路 114ms。

### 已知限制

- **残余误差**：折行型书上有约 119 处「恰好折在引号后」被切成两段，视觉后果是
  「对白结束后叙述另起一段」，在中文小说里常见且不违和。未引入行长统计判据的理由
  见设计文档（需要估计全书折行列宽，对短段型书反而会判错方向）。
- 非有限偏移（±Infinity）一律收敛到下界；调用点传的都是有限数，故无实际影响。
- 偏移单位是 **UTF-16 码元**（与 `String.prototype.slice` 一致），不是码点。

## 10. M2 收尾：阅读助手预设 + 书摘插入 + PDF 划线（2026-10-20）

本轮补完 M2 的最后一块，并顺带支持 PDF 划线。三件事都先**从 DSH 产物里读出真实契约**再动手
（方法见工作区 `docs/m2-composer-and-preset-contracts.md`），没有一条是凭记忆写的。

### 10.1 「阅读助手」Agent 预设

**为什么不是写进 YAML**：`dsh-agent-preset-registry` 的官方说法是「新建 preset 是 bundle 补丁」，
要求手改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 再重启 —— 对「装了插件就想用」是断的。
实测读其 `lib/index.js` 后确认服务确实暴露 `register(definition)`，于是改为插件自己在 apply 里注册，
用户零配置。

**三条实测纪律**：

| 纪律 | 依据 | 做法 |
|---|---|---|
| id 不能与 YAML 撞 | `if (this.definitions.has(definition.id)) throw new Error('Duplicate agent preset')` | 用带前缀的 `reading-workbench-assistant`，撞了只降级、不影响其它功能 |
| `agentPresets` 是**可选**服务 | 写进 `inject` 而宿主没装 → cordis 把 fiber 停在 pending → **全部 REST 路由消失**（与 `web` 那次同一条教训） | 只 `ctx.get` + 显式 try/catch |
| `entryListProblem` 在 `activate` 的 try **之外**抛 | regsitry 源码的 activate 首行 | 外层自己包 try/catch |

**提示词怎么进系统提示词**：`@deepseek-ai/dsh-system-prompt` 的 config **没有 `append`**
（实测只有 `includeHarnessIdentity / includeRuntimeContext / personaPrefix / personaSuffix / toolOrder`），
正确做法是挂一个贡献提示词段的插件行。因此预设的 `plugins` 引用**本包自身**：

```yaml
plugins:
  - name: dsh-reading-workbench
    config: { promptSectionOnly: true, promptText: <阅读助手纪律> }
```

主入口 `apply` 开头看到 `promptSectionOnly` 就转到 `prompt-section.ts` 并 `return`，
不会重复注册路由与工具。段注册走 `ctx.systemPrompt.section({ name, order: 9000, interpolate: false })`
—— `order: 9000` 落在「第一方指导之后、环境信息 10000 之前」；`interpolate: false` 是因为
段里有 `{{…}}` 时插值失败会让**整个提示词组装失败**。

**自测抓到的真缺陷**：首版把 `.then(onRejected)` 挂在 `service.register(...)` 的返回值上，
而 `register()` 是**同步调用**、同步抛（`Duplicate agent preset` / id 为空）时 `.then` 根本来不及挂上，
异常直接穿出 `registerReadingAssistantPreset`。修法：先用 try/catch 把同步抛出收进失败路径，
再处理异步 reject，两条路径归一。

### 10.2 书摘插入（两个入口：会话输入框 + 阅读器划线抽屉）

> ⛔ **已移除（2026-10-20 用户决定）。本节仅作历史与根因记录，代码已全部删除。**
> 移除范围：`ExcerptDock.tsx`、`excerpt.ts`、`conversation.composer.dock` 注册、
> 划线抽屉的「引用到会话」按钮、`quoteExcerpt` 及其自测。
> 移除理由见第 11.7 节：「保留在会话输入框旁」这一形态对用户没有价值。

**契约取证**：该槽位的渲染调用是 `renderSlot("conversation.composer.dock", {})` ——
**owner props 是空对象**，挂进去的组件拿不到输入框 API。写入能力来自 `ui-conversation` 的：

```js
ctx.uiSession.provide({ hooks:['conversation','input'], props:['inputActions'],
  resolve: (binding) => ({ ..., props: { inputActions: shell.actions } }) })
```

`shell.actions` 实测形状：`{ captureInsertion, insertText(text, span), setDraft(text), persistDraft, submit, ... }`。

> ⚠️ **不能自己再 provide 一次**：`ui-session` 的 `claimStandardProp` 对重复声明的 prop
> 直接抛 `uiSession.provide: duplicate prop 'inputActions'`，会打断会话根的 provide 链。只消费，不声明。

**「确认后才发送」怎么保证**：只调 `insertText` / `setDraft` 往草稿写，**任何路径都不调 `submit()`**。
自测里放了一个「只要被调用就记录」的 `submit` 假体，断言全程未被触发（两条路径各一条）。

**插入优先级**（`src/client/excerpt.ts`，纯函数）：
1. `captureInsertion()` + `insertText()` —— 光标处插入，输入框的原生语义；
2. 若 `insertText` 返回 false（草稿版本变了，用户正在打字）→ **回落 `setDraft(已有草稿 + text)`**，
   不能假装成功；
3. 两条都不行 → 返回 false，组件显示「插入失败」，按钮本身在没有写入能力时**直接禁用 + 说明原因**
   （点了没反应是最难查的体验）。

**插进去长什么样**：Markdown 引用块 + 出处，一眼能看出「这是书里的原文」而不是用户自己的话。

```text
> 投资这件事，其实就是做好准备应对未来。
>
> 笔记：这句是全书的方法论起点

—— 《周期》（第 3 章）
```

#### 为什么又加了第二个入口：阅读器划线抽屉的「引用到会话」

**首版只挂 `conversation.composer.dock`，真机验收时用户反馈「没有看到输入框」** ——
这不是注册失败，而是**入口放错了地方**：

`composer.dock` 只在**会话页面**渲染。而阅读面板是 `main` 槽位的 keyed 页面（key=`reading`），
与会话页面**互斥** —— 用户在看书的整个过程中，屏幕上根本没有输入框，那个按钮永远不可达。

⇒ 必须在阅读面板内部提供入口。落点选**划线抽屉里每条划线旁边的「引用到会话」**：
书摘本来就是划线，用户划线后正要打开抽屉看，那里是最自然的位置。

**技术难点**：阅读面板是 root 作用域的 keyed 页面，**拿不到 session 槽位的标准 props**
（`inputActions` 只传给 session / session-maybe 作用域的槽位）。解法是从 client 服务
`uiSession` 取当前 binding：

```js
const binding = ctx.get('uiSession').current.getSnapshot();
const actions = binding.props.inputActions;   // ← 就是 composer 那份 actions
```

`uiSession` 是官方稳定服务（`dsh-client-ui-chat` / `-conversation` / `-approval` /
`-trajectory` / `-user-questions` / `-sidebar-right` 六个内置包都以 `inject: ['uiSession']` 声明），
但仍按可选服务处理：取不到就返回明确原因。

**失败原因必须分两种**（`quoteExcerpt` 纯函数，已单测）：对用户来说这是两个不同动作 ——

| 原因 | 含义 | 文案 |
|---|---|---|
| `no-session` | 当前没打开任何会话 | 「请先新建或进入一个会话」 |
| `unsupported` | 有会话，但输入框不接受程序化写入 | 「可手动复制这条划线」 |

混成一句「插入失败」等于让用户自己猜，是最差的可行动性。

**成功也要提示**：阅读面板占满主区域、输入框不可见，写进草稿后用户看不到任何变化，
所以提示是「已写入会话输入框，切回会话确认后发送」—— 明确告诉他去哪看。

### 10.3 PDF 划线

PDF 页面是 canvas 位图，**没有可选择的 DOM 文本**。做法是渲染时顺带取 `page.getTextContent()`
建文字层，把用户选区与文字项的包围盒求交，得到页内字符偏移。

**锚点复用 `mark:` 格式，旧数据零迁移**：`ch` 字段装**页序号（0 起）**，`off` 装页内字符偏移。
语义与章节书的 `chapter` 同构（先定位单元、再按字符偏移），`mark-anchor.ts` 一行都不用改。

**坐标换算是最容易错的一步**（`src/client/pdf-geometry.ts`）：

```text
tx = composeTransform(viewport.transform, item.transform)
height = hypot(tx[2], tx[3])          ← 不能用 tx[3]（旋转文字会失真）
width  = item.width * viewport.scale  ← 不乘 scale，在 120% 缩放下整体错位
选区矩形 = DOM 视口坐标 − canvas.getBoundingClientRect()
```

**选区判据选「行覆盖」而不是「完全落在矩形内」**：拖选一行时选区矩形通常只包住字形的一部分高度，
要求完全包含会漏掉整行。因此以**垂直重叠 > 50%** 为准，水平只要相交就算。
这是**保守**方向：宁可多选一个字，也不要漏掉用户明确框住的行 —— 漏字会让划线文本与屏幕对不上。

跨行选区用 `range.getClientRects()` 的**多个**矩形（每行一个），不用 `getBoundingClientRect()`
的外接矩形 —— 后者在正文与页边注并排的 PDF 上会把侧栏一起框进来。

高亮画在 canvas **上方**的独立层（`pointer-events: none`），不改 canvas 像素：
缩放、翻页、重渲染都不会累积绘制；`pointer-events: none` 是必须的，否则会挡住文字选择。

**双页模式的一个隐蔽坑**：两个 `PdfSheet` 各自持有自己那一页的文字层。若用 A 页的选区矩形
配 B 页的文字层算偏移，会得到**完全错误且不报错**的锚点。因此选区报告里带上「来自哪一页」，
父级只用该页的文字层计算。

### 10.4 本轮修掉的既有缺陷（非本轮引入）

`ui-render-check` 的书架用例一直失败（`Cannot read properties of undefined (reading 'length')`）。
用 `git stash` 做对照实验确认**这不是本轮引入的**：把本轮改动全部 stash 掉后，同样的三条用例照旧失败。

根因：网页书源（2026-10-19）给 `ShelfView` 加了必需 props `webJobs: WebJob[]`，
但 `ui-render-check` 的 `shelfProps` 没有同步补上，组件里 `webJobs.length` 直接崩。
修法两面都做：测试补全 props（覆盖真实契约），组件对 `webJobs` 给默认值 `[]`（对缺省宽容）。

### 10.5 验证证据

| 套件 | 项数 | 说明 |
|---|---|---|
| `agent-preset-selftest.mjs` | **36** | 定义形状 + 成功路径 + 5 种降级路径（含同步抛 / 异步 reject / `ctx.get` 抛）+ 提示词段参数 |
| `excerpt-dock-selftest.mjs` | **25** | 插入文本格式、两条插入路径、**全程不调用 submit**、回落保留用户草稿、异常不外泄 |
| `pdf-marks-selftest.mjs` | **36** | 矩阵复合 / 高度用 hypot / 宽度乘 scale / 选区减 canvas 偏移 / 页文本偏移契约 / 跨行选区 / 越界不抛错 |
| `ui-render-check.mjs` | +8 项 | 书摘控件两种状态真渲染（有/无写入能力），以及既有的 3 条书架用例修复 |
| `e2e-check.mjs` | 8 → **17** | 进度锚点从 v1 迁到 v2：**v2 串逐字符回读**、章节锚点、旧锚点兼容且不被静默改写；**并补上自清理**（见下） |

`npm run check` 全链路 exit=0；`tsc --noEmit` 0 错误。

### 10.6 真机验收（2026-10-20，重启 DSH 后）

| 项 | 结果 | 证据 |
|---|---|---|
| Host 半新产物生效 | ✅ | 新实例 `http://127.0.0.1:27830`，13 条路由全部注册（400/405 是缺参 / 错方法的正确响应） |
| `e2e-check.mjs`（v2 锚点） | ✅ **15/15** | v2 串逐字符回读、旧锚点原样保留 |
| `real-instance-check.mjs` | ✅ 全绿 | 三格式 + 封面 + 设置 + 划线 + 进度 |
| `/styles`（EPUB 排版） | ✅ | 《周期》返回 6172 字符书内 CSS（`page_styles.css` + `stylesheet.css`） |
| **PDF 文字层真机**（`pdf-textlayer-live-check`） | ✅ **12/12** | 真实 321 页书第 4 页：212 文字项 / 191 非空 / 1845 字符中文；包围盒全部有限且在页内；选区↔恢复闭环成立 |
| **Client 装配**（`client-assembly-check`） | ✅ **16/16** | 真跑 ModuleLoader 信封 + 真 `apply(ctx)`：三个槽位都被 `slots.inject` 包裹、`main` 用 `key`、dock 用 `id` + `order=20`、apply 不抛错 |

**PDF 划线的可用范围（实测，不是估计）**：那本真实书 321 页抽样 41 页，**39 页有文字层（95%）**；
无文字层的是封面 / 标题页 / 插图页（`getTextContent()` 返回 0 项）。
⇒ 扫描版 PDF（整本无文字层）划不了线，这属于格式本身没有可锚定的文本，不是实现缺陷。

> 排查记录：首版验证脚本固定断言「第 3 页有文字项」，而那页恰好是纯图片标题页，导致误判成实现失败。
> 改成「自动找第一页有文字层的页」后全绿 —— 这类**判据挑错样本**的误报，比实现缺陷更容易把人带偏。

**GUI 肉眼确认仍待做**：本机浏览器未开调试端口、GUI 根路径对脚本请求返回 401（trust fence 正常生效），
因此「按钮真的出现在输入框下方 / 「阅读助手」真的出现在预设列表里」这一层，
本轮以「Client 装配 16 项 + Host 路由全注册」作为可自动化验证的上限；
肉眼确认请在 `http://127.0.0.1:27830` 刷新页面后看一眼。

**顺带修掉一个污染用户数据的测试缺陷**：真机验收后书架从 24 本变成 27 本，
多出来的 3 本全是 `sample`。根因是 `e2e-check.mjs` 只删「上传通道」建的书，
**从没删过自己按路径导入的 `fixtures/sample.md`** —— 每跑几次就多一本。
用户书架是真实数据，测试必须把自己造的一切清干净，因此补了两项：
清掉按路径导入的那本，并加一条「跑完后书架上不得有指向 `fixtures/sample.md` 的书」的断言。
历史残留已手工清理，书架恢复 24 本（23 epub + 1 pdf）。

## 11. 方案 A：会话内「阅读」视图 tab（2026-10-20 实现，同日回退）

> ⛔ **已回退（2026-10-20 用户决定：「这样的效果不好，只读书就行了」）。**
> 代码已全部删除：`SessionReadingView.tsx`、`conversation.view` 注册、
> `dsh-reading-session-view` 样式与 `view.reading` 文案。
> 本节保留完整的探查结论与取舍过程 —— 这些契约事实（尤其 11.2、11.3）以后要再评估
> 「要不要给阅读加对话入口」时仍然有效，能省掉重新挖 asar 的时间。
> 回退理由见 11.7。

### 11.1 为什么要重做入口

第 10.2 节那版把「插入书摘」挂在 `conversation.composer.dock`，用户真机反馈「**没有看到输入框**」。
根因不是注册失败，而是**入口位置错了**：阅读面板是 `main` 槽位的 keyed 页面，
与会话页面**互斥** —— 用户从打开书到关掉书的全程，屏幕上没有输入框，那个按钮永远不可达。

用户的诉求原话是「**阅读插件 ui 中应该有自己的 agent 聊天区域，直接插入他自己的聊天区域，
而不是在工作区进行插入**」。这条诉求把落点定死了：聊天区必须**和阅读器在同一个视图里**。

### 11.2 为什么是 `conversation.view`（三个候选的取舍）

| 候选 | 可行性（实测） | 结论 |
|---|---|---|
| 面板内嵌官方会话组件 | `conversation.content` 的 Factory **只继承渲染位置的 Session**，且槽位声明是唯一的（“声明即授权”），插件无权在自己的面板里渲染它 | ❌ 不可行 |
| 面板内自建聊天侧栏 | DSH **没有**官方侧边聊天能力（扫 56 个 client 包）；但 `remote.session` 提供 prompt + follow 历史，**能**自建 —— 等于重写一个精简 chat（流式、工具卡片、错误态） | ⚠️ 可行但代价过大 |
| **阅读器做成会话内 tab** | `conversation.view` 是 list + session 作用域；注册即出现在会话顶部 tab 栏；**正文区被替换，但 composer 常驻** | ✅ 采用 |

关键事实（实测 `dsh-client-ui-conversation/lib/client.js`）：

```js
// 渲染位置：会话正文区；viewId 来自 tab 选择
const viewId = view ?? active?.id;
return jsx("div", { className: viewArea, children:
  viewId !== undefined && renderSlot("conversation.view", { inspectCall, viewRequest, openView, ... }, { only: viewId }) });

// tab 列表由已注册条目生成，注册即出现
const viewTabs = () => { for (const entry of slots.entries("conversation.view")) { ... } };
```

于是布局变成：

```text
┌─ 会话页面 ────────────────────────────┐
│  [聊天] [阅读]     ← conversation.view tab │
├───────────────────────────────────────┤
│   阅读器（书架 / 正文 / 划线抽屉）      │
├───────────────────────────────────────┤
│   输入框（常驻，书摘写这里）            │
└───────────────────────────────────────┘
```

### 11.3 为什么这个方案还能少写代码

`conversation.view` 是 **session 作用域**。session 作用域的槽位会自动收到
`ui-conversation` 经 `ctx.uiSession.provide({ props: ['inputActions'] })` 发布的标准 props。

⇒ 在这个 tab 里，书摘插入是**槽位自带能力**，不需要第 10.2 节那套
`ctx.get('uiSession')` 跨作用域取服务的补丁。少一层间接，也少一个失败点。

### 11.4 实现与复用

- `src/client/panel/SessionReadingView.tsx`：会话内视图，内部**复用同一个 `WorkbenchPage`**
  （书架 + 阅读器 + 划线抽屉），不复制 UI。两个入口共用一份代码，维护面不翻倍。
- `index.tsx`：`slots.inject('conversation.view', () => slots.register({ name, id: 'reading', order: 30, label: () => t('view.reading'), inject: () => ({ api, t }) }, SessionReadingView))`。
- `label` 用 thunk：切换语言后无需重新注册。
- 组件对 `inputActions` 缺失做降级（报 `unsupported` 并提示手动复制），不假装成功。

### 11.5 两个入口的分工

| 入口 | 场景 | 输入框 |
|---|---|---|
| 侧边栏「阅读」→ `main` | 沉浸阅读、整理书架 | 无 |
| 会话内「阅读」tab → `conversation.view` | **边读边问 agent** | 常驻 |

用户为阅读单独开一个会话，这个会话自然就成了「专属阅读会话」—— 书摘与提问都在里面，
不污染工作会话。这也是为什么本轮没有另外做「自动创建专属会话」：
`conversation.view` 天然是**当前会话的一个视图**，把它读作「这个会话的阅读区」比再造一个会话更简单可靠。

### 11.6 验证（实现当时的记录）

| 项 | 结果 |
|---|---|
| `client-assembly-check.mjs` | 24 项（含本 tab：id/order/label thunk/inject/label 解析为「阅读」） |
| `ui-render-check.mjs` | +2 项：会话内阅读视图真渲染不抛错、带语义锚点 |
| `npm run check` | exit=0 |

### 11.7 为什么回退（2026-10-20 用户决定）

用户在原话里给的理由是「**这样的效果不好，只读书就行了**」，明确要求回到只做阅读。
同批一起移除的还有 `composer.dock` 的「插入书摘」——两者是同一个诉求的两个落点。

回退后的边界（已固化进 `client-assembly-check` 的**反向断言**）：

```text
PASS  不注册会话域槽位（只读书）
PASS  注册表里只有 sidebar.panellist 与 main 两个槽位
PASS  反证：手动注册一个会话域槽位能被记录（判据不是空转）
```

第三条是反证 —— 保证前两条不是「判据恒真」的空转断言。以后若有人再加会话域槽位，
这两条会立刻失败，逼他先回答「用户当初为什么去掉它」。

**保留的部分**：这次为排查「划线保存失败」做的修复全部保留 ——
浮动按钮 `mousedown` 的 `preventDefault`、`resolveFlowRoot` 的 DOM 兜底、
以及三处静默 return 改为显式提示。它们与书摘功能无关，是阅读本身的真缺陷。




