/**
 * 面板高度链验证（真实浏览器）。
 *
 * 为什么需要：`main` 槽位的宿主容器高度由 DSH 的布局组件决定，
 * 我的样式用 `height: 100%` 贯穿 `.dsh-reading-page → .dsh-reading-view → .dsh-reading-shelf/reader`。
 * 若宿主没给出确定高度，`100%` 会塌陷，书架网格与分页视口都会变成 0 高（看起来像「空白面板」）。
 *
 * 本脚本用 DSH 布局里实测的容器几何（`.frame` = grid / `grid-template-rows: 100%`、
 * `.centerCol` = flex column / `overflow: hidden`）搭一个替身宿主，
 * 把我真实的样式表与面板结构塞进去，量各层实际高度。
 *
 * 用法：node scripts/panel-height-check.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { STYLES } from '../src/client/styles.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => candidate !== '');

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.log('未找到 Chrome / Edge，跳过面板高度链验证（不影响交付）。');
  process.exit(0);
}

// 主题 token 的最小替身（真实值由 DSH 注入；这里只需变量存在，量的是高度不是颜色）
const TOKEN_STUB = `:root {
  --dsw-alias-bg-base: #101014; --dsw-alias-bg-layer-1: #17171d; --dsw-alias-bg-layer-2: #1e1e26;
  --dsw-alias-bg-overlay: #20202a; --dsw-alias-border-l1: #2a2a34; --dsw-alias-border-l2: #3a3a46;
  --dsw-alias-brand-primary: #4c8dff; --dsw-alias-label-primary: #e8e8ee; --dsw-alias-label-secondary: #9a9aa8;
  --dsw-alias-state-error-primary: #ff6b6b; --dsw-alias-state-success-primary: #4ecb8f;
  --dsw-specific-sidebar-fill: #12121a;
}`;

/** 复刻 DSH 布局的几何：三列 grid（行高 100%）+ 中间列 flex column + overflow hidden。 */
const HOST_GEOMETRY = `
  html, body { margin: 0; padding: 0; height: 100%; }
  /* .frame：[data-dragging] grid-template-rows:100%; display:grid; overflow:hidden */
  #frame { display: grid; grid-template-columns: 260px 1fr 0px; grid-template-rows: 100%; height: 100%; overflow: hidden; }
  #sidebarCol { background: var(--dsw-specific-sidebar-fill); min-width: 0; overflow: hidden; }
  /* .centerCol：flex-direction:column; min-width:0; display:flex; overflow:hidden */
  #centerCol { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
  /* main 槽位里的面板宿主：DSH 渲染我的组件到这里 */
  #mainSlot { flex: 1; min-height: 0; display: flex; flex-direction: column; }
`;

/** 面板结构（与 WorkbenchPage 渲染出的 DOM 同构，含书架态与阅读态两套）。 */
function paneMarkup(kind) {
  const inner =
    kind === 'shelf'
      ? `<header class="dsh-reading-shelfbar">
           <div class="dsh-reading-shelfbar-left"><h2 class="dsh-reading-shelfbar-title">书架</h2><span class="dsh-reading-shelfbar-count">3 本</span></div>
           <div class="dsh-reading-shelfbar-right"><input class="dsh-reading-search" placeholder="搜索书名或作者"><button class="dsh-reading-primary">导入书籍</button></div>
         </header>
         <ul class="dsh-reading-grid">
           ${Array.from({ length: 9 }, (_, i) => `<li class="dsh-reading-card">
             <button class="dsh-reading-cardcover"><div class="dsh-reading-gencover" style="background-image:linear-gradient(150deg,hsl(200 42% 62%),hsl(224 46% 42%))"><span class="dsh-reading-gencover-title">样例书籍 ${i + 1}</span><span class="dsh-reading-gencover-author">作者</span></div><span class="dsh-reading-badge">EPUB</span></button>
             <div class="dsh-reading-cardmeta"><button class="dsh-reading-cardtitle">样例书籍 ${i + 1}</button><span class="dsh-reading-cardauthor">作者</span></div>
           </li>`).join('')}
         </ul>`
      : `<header class="dsh-reading-toolbar">
           <button class="dsh-reading-iconbtn">‹ 返回书架</button>
           <div class="dsh-reading-toolbar-title"><span class="dsh-reading-toolbar-book">样例电子书</span><select class="dsh-reading-chapterselect"><option>1. 第一章</option></select></div>
           <div class="dsh-reading-toolbar-actions"><div class="dsh-reading-segmented"><button class="dsh-reading-seg">自适应</button><button class="dsh-reading-seg dsh-reading-seg-active">单页</button><button class="dsh-reading-seg">双页</button></div><button class="dsh-reading-iconbtn">A－</button><button class="dsh-reading-iconbtn">A＋</button></div>
         </header>
         <div class="dsh-reading-viewport" id="probeViewport"><div class="dsh-reading-flow" id="probeFlow">${Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 段：用于撑开版面的正文内容。`.repeat(6) + '</p>').join('')}</div></div>
         <footer class="dsh-reading-statusbar"><button class="dsh-reading-iconbtn">‹</button><span class="dsh-reading-pager">章节 1/2 · 1/1 页</span><div class="dsh-reading-progressbar"><div class="dsh-reading-progressbar-fill" style="width:40%"></div></div><span class="dsh-reading-percent">40%</span><button class="dsh-reading-iconbtn">›</button></footer>`;

  return `<div class="dsh-reading-view" data-mode="${kind}">
    <div class="dsh-reading-shelf" style="display:${kind === 'shelf' ? 'flex' : 'none'}">${kind === 'shelf' ? inner : ''}</div>
  </div>`
    .replace('<div class="dsh-reading-shelf" style="display:none"></div>', '');
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>height probe</title>
<style id="tokens">__TOKENS__</style>
<style id="hostgeom">__HOSTGEOM__</style>
<style id="panelcss"></style>
</head><body>
<div id="frame">
  <div id="sidebarCol"></div>
  <div id="centerCol">
    <div class="dsh-reading-page" id="panelPage"><div class="dsh-reading-view" id="panelView"></div></div>
  </div>
  <div></div>
</div>
<pre id="out"></pre>
<pre id="err"></pre>
<script>
window.addEventListener('error', (e) => {
  document.getElementById('err').textContent = 'ERROR: ' + (e.message || e.error) + ' @' + e.lineno;
});
try {
  document.getElementById('panelcss').textContent = __PANEL_CSS__;

  function mount(kind) {
    const view = document.getElementById('panelView');
    view.setAttribute('data-mode', kind);
    view.innerHTML = kind === 'shelf' ? __SHELF__ : __READER__;
    if (kind === 'reader') {
      // 复刻 FlowReader 施加的内联样式（多栏分页靠它们生效）
      const flow = document.getElementById('probeFlow');
      const viewport = document.getElementById('probeViewport');
      const GAP = 48;
      const W = Math.max(120, viewport.clientWidth - 64);   // 单页：视口内容宽度
      flow.style.height = viewport.clientHeight + 'px';
      flow.style.width = W + 'px';
      flow.style.columnWidth = W + 'px';
      flow.style.columnGap = GAP + 'px';
      flow.style.columnFill = 'auto';
      flow.style.fontSize = '17px';
      flow.style.lineHeight = '1.9';
      flow.style.transform = 'translateX(0px)';
    }
    return view;
  }

  function measure(kind) {
    mount(kind);
    const q = (sel) => document.querySelector(sel);
    const h = (el) => (el === null ? null : Math.round(el.getBoundingClientRect().height));
    const result = {
      kind,
      windowHeight: window.innerHeight,
      page: h(q('#panelPage')),
      view: h(q('#panelView')),
    };
    if (kind === 'shelf') {
      result.shelf = h(q('.dsh-reading-shelf'));
      result.grid = h(q('.dsh-reading-grid'));
      result.cardCover = h(q('.dsh-reading-cardcover'));
      result.cardCount = document.querySelectorAll('.dsh-reading-card').length;
    } else {
      result.reader = h(q('.dsh-reading-reader'));
      result.toolbar = h(q('.dsh-reading-toolbar'));
      result.viewport = h(q('#probeViewport'));
      result.statusbar = h(q('.dsh-reading-statusbar'));
      const flow = q('#probeFlow');
      result.flowScrollWidth = flow === null ? null : flow.scrollWidth;
      result.flowClientWidth = flow === null ? null : flow.clientWidth;
    }
    return result;
  }

  document.getElementById('out').textContent = JSON.stringify({
    shelf: measure('shelf'),
    reader: measure('reader'),
  }, null, 2);
} catch (error) {
  document.getElementById('err').textContent = 'THROWN: ' + (error && error.stack ? error.stack : error);
}
</script></body></html>`;

// 面板结构：两层壳。注意 WorkbenchPage 的根是 .dsh-reading-view，page 壳在外层。
const SHELF_INNER = paneMarkup('shelf');
const READER_INNER = `
  <section class="dsh-reading-reader">
    <header class="dsh-reading-toolbar">
      <button class="dsh-reading-iconbtn">‹ 返回书架</button>
      <div class="dsh-reading-toolbar-title"><span class="dsh-reading-toolbar-book">样例电子书</span><select class="dsh-reading-chapterselect"><option>1. 第一章</option></select></div>
      <div class="dsh-reading-toolbar-actions"><div class="dsh-reading-segmented"><button class="dsh-reading-seg">自适应</button><button class="dsh-reading-seg dsh-reading-seg-active">单页</button><button class="dsh-reading-seg">双页</button></div><button class="dsh-reading-iconbtn">A－</button><button class="dsh-reading-iconbtn">A＋</button></div>
    </header>
    <div class="dsh-reading-viewport" id="probeViewport"><div class="dsh-reading-flow" id="probeFlow">${Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 段：用于撑开版面的正文内容。`.repeat(6) + '</p>').join('')}</div></div>
    <footer class="dsh-reading-statusbar"><button class="dsh-reading-iconbtn">‹</button><span class="dsh-reading-pager">章节 1/2 · 1/1 页</span><div class="dsh-reading-progressbar"><div class="dsh-reading-progressbar-fill" style="width:40%"></div></div><span class="dsh-reading-percent">40%</span><button class="dsh-reading-iconbtn">›</button></footer>
  </section>`;

const page = PAGE.replace('__TOKENS__', TOKEN_STUB)
  .replace('__HOSTGEOM__', HOST_GEOMETRY)
  .replace('__PANEL_CSS__', JSON.stringify(STYLES))
  .replace('__SHELF__', JSON.stringify(SHELF_INNER))
  .replace('__READER__', JSON.stringify(READER_INNER));

const pagePath = join(tmpdir(), `rw-panel-height-${process.pid}.html`);
await writeFile(pagePath, page, 'utf8');

const { stdout } = await execFileAsync(
  browser,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1440,900', '--virtual-time-budget=4000', '--dump-dom', `file:///${pagePath.split('\\').join('/')}`],
  { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
);

const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout);
const errMatch = /<pre id="err">([\s\S]*?)<\/pre>/.exec(stdout);
const measured = match === null || match[1].trim() === ''
  ? undefined
  : JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

if (measured === undefined) {
  console.log('页面脚本未能产出测量结果。');
  if (errMatch !== null && errMatch[1].trim() !== '') console.log('页面报错：', errMatch[1].trim());
  else console.log(stdout.slice(0, 600));
  await unlink(pagePath).catch(() => undefined);
  process.exit(1);
}

console.log(`视口高度 ${measured.shelf.windowHeight}px\n`);
console.log('书架态：', JSON.stringify(measured.shelf));
console.log('阅读态：', JSON.stringify(measured.reader));
console.log('');

const shelf = measured.shelf;
const reader = measured.reader;

// 核心：高度必须真的撑开，不能塌陷
check('面板页高度撑满宿主', shelf.page > 400, `page=${shelf.page}px`);
check('书架态视图高度撑满', shelf.view > 400, `view=${shelf.view}px`);
check('书架滚动区高度撑满', shelf.shelf !== null && shelf.shelf > 400, `shelf=${shelf.shelf}px`);
check('书卡封面按 2:3 渲染（有实际高度）', shelf.cardCover !== null && shelf.cardCover > 150, `cover=${shelf.cardCover}px`);
check('书卡全部渲染', shelf.cardCount === 9, `共 ${shelf.cardCount} 张`);
check('网格有高度', shelf.grid !== null && shelf.grid > 200, `grid=${shelf.grid}px`);

check('阅读器高度撑满', reader.reader !== null && reader.reader > 400, `reader=${reader.reader}px`);
check('分页视口有确定高度', reader.viewport !== null && reader.viewport > 200, `viewport=${reader.viewport}px`);
check('工具条与状态条各占一行', reader.toolbar > 20 && reader.statusbar > 20, `toolbar=${reader.toolbar} statusbar=${reader.statusbar}`);
check(
  '工具条 + 视口 + 状态条 ≈ 阅读器高度（不溢出、不留空）',
  Math.abs((reader.toolbar + reader.viewport + reader.statusbar) - reader.reader) <= 2,
  `${reader.toolbar}+${reader.viewport}+${reader.statusbar}=${reader.toolbar + reader.viewport + reader.statusbar} vs ${reader.reader}`,
);
check('正文产生横向溢出（分栏生效）', reader.flowScrollWidth > reader.flowClientWidth, `scrollWidth=${reader.flowScrollWidth} clientWidth=${reader.flowClientWidth}`);

await unlink(pagePath).catch(() => undefined);
console.log(allPass ? '\n面板高度链验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
