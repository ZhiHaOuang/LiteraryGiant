/**
 * 插件样式（UI v2）。
 *
 * 约定（agents.md §5.4）：选择器一律加 `dsh-reading-` 前缀；
 * 颜色只用主题 token（`--dsw-alias-*`）；尺寸/间距可硬编码。
 * 唯一例外是**生成式封面的渐变底色**——那是书籍内容的一部分，
 * 用 HSL 字面量按书名取色，不随明暗主题改变（见 ShelfView.tsx 的说明）。
 */
export const STYLE_ID = 'dsh-reading-workbench-style';

/** 面板样式文本。 */
export const STYLES = `
/* ── 根容器 ───────────────────────────────────────────── */
.dsh-reading-page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dsh-reading-view { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }

/* ── 书架：工具条 ─────────────────────────────────────── */
.dsh-reading-shelf { display: flex; flex-direction: column; gap: 16px; flex: 1; min-height: 0; padding: 20px 24px 28px; overflow: auto; transition: background .15s; }
.dsh-reading-dragging { background: var(--dsw-alias-bg-layer-2); }
.dsh-reading-shelfbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dsh-reading-shelfbar-left { display: flex; align-items: baseline; gap: 8px; }
.dsh-reading-shelfbar-title { margin: 0; font-size: 18px; font-weight: 600; }
.dsh-reading-shelfbar-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-reading-shelfbar-right { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.dsh-reading-search, .dsh-reading-sort { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
.dsh-reading-search { width: 180px; }
.dsh-reading-search:focus, .dsh-reading-sort:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-reading-primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border: 1px solid transparent; border-radius: 8px; padding: 7px 16px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; }
.dsh-reading-primary:hover:not(:disabled) { opacity: .9; }
.dsh-reading-primary:disabled { opacity: .5; cursor: default; }

/* ── 书架：网格与书卡 ─────────────────────────────────── */
.dsh-reading-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 24px 20px; }
.dsh-reading-card { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-reading-cardcover { position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px 8px 8px 4px; overflow: hidden; cursor: pointer; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 2px 10px rgb(0 0 0 / .18); transition: transform .16s ease, box-shadow .16s ease; }
.dsh-reading-cardcover:hover { transform: translateY(-3px); box-shadow: 0 8px 22px rgb(0 0 0 / .26); }
.dsh-reading-coverimg { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsh-reading-gencover { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; padding: 14px 12px 12px 16px; box-sizing: border-box; color: rgb(255 255 255 / .96); text-shadow: 0 1px 2px rgb(0 0 0 / .28); }
.dsh-reading-gencover-title { font-size: 14px; font-weight: 600; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.dsh-reading-gencover-author { font-size: 11px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-reading-badge { position: absolute; top: 6px; right: 6px; font-size: 9px; font-weight: 600; letter-spacing: .04em; padding: 2px 6px; border-radius: 999px; background: rgb(0 0 0 / .42); color: rgb(255 255 255 / .94); backdrop-filter: blur(2px); }
.dsh-reading-cardprogress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgb(0 0 0 / .3); }
.dsh-reading-cardprogress-fill { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.dsh-reading-cardmeta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-reading-cardtitle { background: none; border: 0; padding: 0; text-align: left; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); cursor: pointer; font-family: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-reading-cardtitle:hover { color: var(--dsw-alias-brand-primary); }
.dsh-reading-cardauthor { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-reading-cardremove { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; border: 1px solid transparent; background: rgb(0 0 0 / .42); color: rgb(255 255 255 / .92); font-size: 13px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .15s; }
.dsh-reading-card:hover .dsh-reading-cardremove { opacity: 1; }
.dsh-reading-cardremove:hover { background: var(--dsw-alias-state-error-primary); }
.dsh-reading-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 40px 20px; }
.dsh-reading-empty-title { margin: 0; font-size: 15px; color: var(--dsw-alias-label-primary); }

/* ── 阅读器：工具条 ───────────────────────────────────── */
.dsh-reading-reader { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.dsh-reading-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); flex-wrap: wrap; }
.dsh-reading-toolbar-title { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.dsh-reading-toolbar-book { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 32%; }
.dsh-reading-toolbar-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dsh-reading-iconbtn { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 4px 9px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap; }
.dsh-reading-iconbtn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-reading-iconbtn:disabled { opacity: .38; cursor: default; }
.dsh-reading-chapterselect { flex: 1; min-width: 0; max-width: 320px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 4px 6px; font-size: 12px; font-family: inherit; }
.dsh-reading-segmented { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; overflow: hidden; }
.dsh-reading-seg { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border: 0; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; border-right: 1px solid var(--dsw-alias-border-l1); }
.dsh-reading-seg:last-child { border-right: 0; }
.dsh-reading-seg-active { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 500; }

/* ── 阅读器：分页正文 ─────────────────────────────────── */
.dsh-reading-viewport { flex: 1; min-height: 0; overflow: hidden; position: relative; padding: 0 32px; }
.dsh-reading-flow { box-sizing: content-box; transition: transform .16s ease; word-break: break-word; hyphens: auto; text-align: justify; }
/* 连续翻页（键盘连发 / 长按）时由 JS 打上 data-instant：直接落位不做动画，
   否则每次按键都会重启滑动动画，页面"追不上"按键，观感就是翻页不准。 */
.dsh-reading-flow[data-instant='true'] { transition: none; }
.dsh-reading-flow-plain { text-align: left; }
.dsh-reading-flow > :first-child { margin-top: 0; }
/* 正文排版（章节 HTML 与 Markdown 共用）*/
.dsh-reading-flow h1, .dsh-reading-flow h2, .dsh-reading-flow h3, .dsh-reading-flow h4, .dsh-reading-flow h5, .dsh-reading-flow h6 { margin: 1.3em 0 .55em; line-height: 1.32; font-weight: 600; break-after: avoid; }
.dsh-reading-flow h1 { font-size: 1.5em; }
.dsh-reading-flow h2 { font-size: 1.28em; padding-bottom: .25em; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-reading-flow h3 { font-size: 1.12em; }
.dsh-reading-flow h4, .dsh-reading-flow h5, .dsh-reading-flow h6 { font-size: 1em; }
.dsh-reading-flow p { margin: 0 0 1em; }
.dsh-reading-flow ul, .dsh-reading-flow ol { margin: 0 0 1em; padding-left: 1.6em; }
.dsh-reading-flow li { margin: .25em 0; }
.dsh-reading-flow li > ul, .dsh-reading-flow li > ol { margin: .25em 0; }
.dsh-reading-flow blockquote { margin: 0 0 1em; padding: .2em 1em; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-radius: 0 6px 6px 0; }
.dsh-reading-flow code { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; padding: .1em .35em; font-size: .9em; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.dsh-reading-flow pre { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px 14px; overflow: auto; margin: 0 0 1em; break-inside: avoid; }
.dsh-reading-flow pre code { background: transparent; border: 0; padding: 0; }
.dsh-reading-flow table { border-collapse: collapse; margin: 0 0 1em; width: 100%; }
.dsh-reading-flow th, .dsh-reading-flow td { border: 1px solid var(--dsw-alias-border-l1); padding: 6px 10px; text-align: left; }
.dsh-reading-flow th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.dsh-reading-flow a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.dsh-reading-flow a:hover { text-decoration: underline; }
.dsh-reading-flow img { max-width: 100%; height: auto; border-radius: 6px; break-inside: avoid; }
.dsh-reading-flow hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 1.5em 0; }
/* TXT 段落（layoutTxt 产物：每段一个 <p>，见 ../client/txt-layout.ts）。
   段间距取 .55em（比正文默认 1em 紧），段首统一 2em 缩进 —— 原文自带的全角缩进
   已在 layoutTxt 里剥掉，这里的缩进是唯一来源，因此不会出现"双缩进"。
   ⚠️ break-inside 必须是 auto：段落允许跨屏断开。写成 avoid 会让排版引擎先把整段
   当成不可分割块测高度，多栏分页会直接坏掉（上一轮长文本分栏 P1 踩过的同一个坑）。
   历史包袱：这里原有两条 .dsh-reading-plain 规则（整本 TXT 塞进一个 pre 元素，
   还要显式把 pre 还原成普通流内容）。TXT 已改成 p 结构，2026-10-19 一并删除 ——
   删前 grep 过 src 全量，已无任何引用（不产 pre 就永远不可能命中，留着只会误导）。 */
.dsh-reading-flow-plain p { margin: 0 0 .55em; text-indent: 2em; break-inside: auto; }
/* 章节书（epub/mobi/web）统一排版：书内 CSS 缺失、或用户选了「统一美化」时生效。
   特异性刻意留低（0,1,1）：书内规则经作用域化变成 .dsh-reading-flow .calibre_2（0,2,0），
   天然盖掉本组 —— 正是「恢复原书排版」想要的结果，无需 !important。
   注意这里只能处理「段落」层面：epub 的标题常常只是带 class 的 p 元素，
   没有语义标签就无法在不做语义推断的前提下识别（不做假阳性高的推断，见 book-css.ts 注释）。 */
.dsh-reading-flow-book p { margin: 0 0 .6em; text-indent: 2em; }
.dsh-reading-flow-book blockquote { text-indent: 0; }
.dsh-reading-flow-book blockquote p { text-indent: 0; margin-bottom: .3em; }
.dsh-reading-flow-book img { display: block; margin: .8em auto; }
.dsh-reading-flow-book > :first-child { margin-top: 0; }

/* ── 阅读器：状态条 ───────────────────────────────────── */
.dsh-reading-statusbar { display: flex; align-items: center; gap: 10px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-reading-pager { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-reading-progressbar { flex: 1; height: 3px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsh-reading-progressbar-fill { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .2s; }
.dsh-reading-percent { font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 34px; text-align: right; }

/* ── PDF ──────────────────────────────────────────────── */
.dsh-reading-pdf { display: flex; flex-direction: column; align-items: center; gap: 12px; flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 20px; }
.dsh-reading-pdfnav { display: flex; align-items: center; gap: 8px; position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 4px 10px; }
.dsh-reading-pdfsep { width: 1px; height: 16px; background: var(--dsw-alias-border-l1); }
.dsh-reading-pdfpages { display: flex; gap: 12px; align-items: flex-start; justify-content: center; }
.dsh-reading-pdf-canvas { max-width: 100%; height: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; background: var(--dsw-alias-bg-layer-2); box-shadow: 0 2px 8px rgb(0 0 0 / .18); }

/* ── 划线 ─────────────────────────────────────────────── */
/* 正文里的高亮（mark 元素由 marks.ts 动态包裹） */
.dsh-reading-flow mark.dsh-reading-mark { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.dsh-reading-flow mark.dsh-reading-mark:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); cursor: pointer; }
/* 选区浮动条 */
.dsh-reading-markpopup { position: absolute; z-index: 6; display: flex; gap: 6px; }
.dsh-reading-markpopup-btn { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border: 0; border-radius: 7px; padding: 5px 14px; font-size: 12px; font-weight: 500; cursor: pointer; box-shadow: 0 3px 12px rgb(0 0 0 / .28); font-family: inherit; }
.dsh-reading-markpopup-btn:hover { opacity: .92; }
/* 笔记抽屉 */
.dsh-reading-marksbtn-active { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-reading-markdrawer { position: absolute; top: 0; right: 0; bottom: 0; width: 320px; max-width: 85%; background: var(--dsw-alias-bg-layer-1); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -6px 0 20px rgb(0 0 0 / .18); transform: translateX(102%); transition: transform .18s ease; z-index: 5; display: flex; flex-direction: column; }
.dsh-reading-markdrawer-open { transform: translateX(0); }
.dsh-reading-markdrawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-reading-markdrawer-title { flex: 1; font-size: 13px; font-weight: 500; }
.dsh-reading-markdrawer-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 24px 16px; margin: 0; line-height: 1.7; }
.dsh-reading-marklist { list-style: none; margin: 0; padding: 8px 10px 20px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.dsh-reading-markitem { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); display: flex; flex-direction: column; gap: 6px; }
.dsh-reading-markquote { margin: 0; padding: 2px 8px; border-left: 3px solid var(--dsw-alias-brand-primary); font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-primary); }
.dsh-reading-marknote { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; cursor: text; white-space: pre-wrap; }
.dsh-reading-markaddnote { background: none; border: 0; padding: 0; text-align: left; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-family: inherit; }
.dsh-reading-markaddnote:hover { color: var(--dsw-alias-brand-primary); }
.dsh-reading-marknote-input { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 5px 8px; font-size: 12px; line-height: 1.5; font-family: inherit; resize: vertical; }
.dsh-reading-marknote-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-reading-markitem-actions { display: flex; gap: 6px; justify-content: flex-end; }
.dsh-reading-markdelete:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }

/* ── 通用 ─────────────────────────────────────────────── */
.dsh-reading-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 0; }
/* 工具条里的紧凑下拉（排版来源 / 字体）：宽度收上限，窄屏时宁可截断也不挤掉翻页按钮 */
.dsh-reading-toolbar-select { max-width: 104px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; padding: 4px 6px; font-size: 12px; font-family: inherit; }
/* 降级提示条（书内样式加载失败）：不阻断阅读，只是把「看到的是统一美化」讲清楚 */
.dsh-reading-hint-warn { padding: 6px 14px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-reading-center { text-align: center; padding: 40px 0; }
.dsh-reading-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; margin: 0; }
.dsh-reading-notice { color: var(--dsw-alias-state-success-primary); font-size: 13px; margin: 0; }
.dsh-reading-floating { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 5; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 4px 14px; box-shadow: 0 2px 10px rgb(0 0 0 / .16); }

/* ── 网页书源 ─────────────────────────────────────────── */
/* 入口按钮与「导入书籍」并列：次级按钮（描边）而非主按钮，避免两个主按钮抢注意力 */
.dsh-reading-secondary { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 16px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; }
.dsh-reading-secondary:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-reading-secondary:disabled { opacity: .5; cursor: default; }

/* 轻量输入条：内联展开在工具条下方，不做模态遮罩（书架动线不被打断） */
.dsh-reading-webform { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsh-reading-webform-label { font-size: 13px; font-weight: 500; white-space: nowrap; }
.dsh-reading-webform-input { flex: 1; min-width: 220px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
.dsh-reading-webform-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-reading-webform-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-reading-webform-hint { flex-basis: 100%; }

/* 抓取进度卡：建书后占满一行，展示「已抓/总数 + 进度条 + 暂停/继续」 */
.dsh-reading-webjobs { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 0; }
.dsh-reading-webjob { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsh-reading-webjob-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-reading-webjob-title { font-size: 13px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-reading-webjob-status { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-reading-webjob-status[data-state='done'] { color: var(--dsw-alias-state-success-primary); }
.dsh-reading-webjob-status[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.dsh-reading-webjob-bar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsh-reading-webjob-bar-fill { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .25s; }
.dsh-reading-webjob-actions { display: flex; align-items: center; gap: 6px; }
/* 书卡上的「网页」来源标识：叠在格式徽标上方，用品牌色与文件类书籍区分 */
.dsh-reading-badge-web { top: 26px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); backdrop-filter: none; }

/* 阅读器工具条上的「已下载 N / 共 M」小字（仅网页书显示）。
   与章节下拉同排：下拉是主体，这里只做状态补语，所以给固定上限并允许省略，
   窄屏时宁可截断也不把下拉挤到看不见。 */
.dsh-reading-chapterstatus { font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }

/* 章节下拉里的逐章抓取状态：✓ 已下载（加粗）/ ↓ 未下载（次级色）。
   ⚠️ 原生 <option> 的弹层由系统绘制，字体与颜色在部分平台（尤其 Windows Chrome 的部分版本）
   不一定生效 —— 因此状态**主要靠文案前缀表达**，这两条只是能生效时的增强，不能作为唯一信号。 */
.dsh-reading-chapterselect option[data-fetched='true'] { font-weight: 600; }
.dsh-reading-chapterselect option[data-fetched='false'] { color: var(--dsw-alias-label-secondary); }

/* 加载失败态：替代「加载中…」空转，给出原样错误 + 重试入口。
   与 .dsh-reading-center 的区别：这里是错误而不是加载，需要留出多行中文说明的宽度。 */
.dsh-reading-loadfail { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 24px; text-align: center; }
.dsh-reading-loadfail .dsh-reading-error { max-width: 560px; line-height: 1.7; }
.dsh-reading-loadfail .dsh-reading-hint { max-width: 560px; line-height: 1.7; }

/* ── PDF 划线（2026-10-20）──
   高亮与浮动按钮都画在 canvas **上方**的独立层，不改动 canvas 像素：
   缩放/翻页/重渲染都不会累积绘制。高亮层必须 pointer-events: none，
   否则它会挡住 canvas 上的文字选择（浏览器把 selection 挂在承载文字的层上）。 */
.dsh-reading-pdfsheet { position: relative; display: inline-block; }
.dsh-reading-pdfmarks { position: absolute; inset: 0; pointer-events: none; }
.dsh-reading-pdfmark { position: absolute; border-radius: 2px; background: var(--dsw-alias-brand-primary); opacity: 0.28; }
.dsh-reading-pdfmarkbtn { position: absolute; }

/* 划线失败提示：浮在正文上方，不挤占排版高度。
   阅读面板占满主区域，没有第二个提示位；失败原因必须被看见
   （否则「点了没反应」又回来了）。 */
.dsh-reading-floating { position: absolute; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 30; margin: 0; padding: 8px 16px; border-radius: 8px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); font-size: 13px; white-space: nowrap; }
`;
