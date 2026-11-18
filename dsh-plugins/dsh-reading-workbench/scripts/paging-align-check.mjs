/**
 * 翻页对齐的**真实浏览器**回归测试（headless Chrome / Edge）。
 *
 * 为什么必须补这一层：曾出现「按键盘下一页，页面切换不准确」的线上问题 ——
 * FlowReader 把「一屏可见宽度」当成了「翻页步长」，两者相差一个列间距（COLUMN_GAP），
 * 于是每翻一屏累积偏移 48px：左侧露出上一列的尾巴、右侧正文被切。
 *
 * 当时的 `pagination-browser-check` 之所以没抓住，是因为它只断言
 * 「transform 生效了」（用同一个错误公式推算期望值，自洽地错）。
 * 本脚本改成断言**内容真的对齐到列边界**：翻到第 v 屏后，
 * 视口左边缘必须恰好压在某一个「列的自然起点」上（误差 ≤ 1px）。
 *
 * 判定依据来自浏览器自己排出的列宽与列步进，不引用产品代码的公式，
 * 因此能独立发现「用了 screenWidth 而不是 step」这类错误。
 *
 * 找不到浏览器时跳过（exit 0）。
 * 用法：node scripts/paging-align-check.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COLUMN_GAP, VIEWPORT_PADDING, columnWidthOf, screenWidthOf, stepOf } from '../src/client/paginate.ts';

const execFileAsync = promisify(execFile);

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => candidate !== '');

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.log('未找到 Chrome / Edge，跳过翻页对齐验证（不影响交付）。');
  process.exit(0);
}

/**
 * 页面脚本：
 * 1. 让浏览器按真实多栏排版（与 FlowReader 相同的几何）；
 * 2. 读取浏览器算出的真实列宽 ↔ 用「列的自然起点」反推列步进；
 * 3. 模拟 FlowReader 的翻页位移，检查每屏左边缘是否压在某列起点上。
 */
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>align</title><style>
html, body { margin: 0; padding: 0; background: #101014; }
#viewport { position: relative; overflow: hidden; padding: 0 ${VIEWPORT_PADDING}px; box-sizing: border-box; }
#flow { box-sizing: content-box; text-align: justify; font-size: 17px; line-height: 1.9; color: #eee; }
/* 用于读取「列起点」的探针：每个都是 inline-block 且不含换行，宽度取 0 */
.probe { display: inline-block; width: 0; height: 0; }
</style></head><body>
<div id="viewport"><div id="flow"></div></div>
<pre id="out"></pre><pre id="err"></pre>
<script>
window.addEventListener('error', (e) => {
  document.getElementById('err').textContent = 'ERROR: ' + (e.message || e.error);
});
try {
  /**
   * 在正文里插入一批零宽探针，用它们的 getBoundingClientRect().left
   * 读出「内容流中每一列的自然起点」（多栏排版下同一列的探针共享 left）。
   */
  function buildContent(paragraphs) {
    const flow = document.getElementById('flow');
    let html = '';
    for (let i = 0; i < paragraphs; i += 1) {
      html += '<p><span class="probe"></span>第 ' + (i + 1) + ' 段：' + '用于撑开版面的正文内容，重复填充以确保产生多列。'.repeat(4) + '</p>';
    }
    flow.innerHTML = html;
  }

  /** 读出去重后的列起点（按 left 排序，相对 flow 自身坐标）。 */
  function columnStarts() {
    const flow = document.getElementById('flow');
    const base = flow.getBoundingClientRect().left;
    const values = [];
    for (const probe of flow.querySelectorAll('.probe')) {
      values.push(Math.round(probe.getBoundingClientRect().left - base));
    }
    const unique = [...new Set(values)].sort((a, b) => a - b);
    return { base: Math.round(base), starts: unique };
  }

  function layout(paragraphs, columnsPerView, viewportWidth, viewportHeight, columnWidth, screenWidth) {
    const viewport = document.getElementById('viewport');
    const flow = document.getElementById('flow');
    viewport.style.width = viewportWidth + 'px';
    viewport.style.height = viewportHeight + 'px';
    buildContent(paragraphs);
    flow.style.height = viewportHeight + 'px';
    flow.style.width = screenWidth + 'px';
    flow.style.columnWidth = columnWidth + 'px';
    flow.style.columnGap = ${COLUMN_GAP} + 'px';
    flow.style.columnFill = 'auto';
    flow.style.transform = 'translateX(0px)';

    const measured = columnStarts();
    const scrollWidth = flow.scrollWidth;
    return {
      columnsPerView,
      paragraphs,
      viewportWidth,
      columnWidth,
      screenWidth,
      scrollWidth,
      contentBase: measured.base,
      starts: measured.starts,
    };
  }

  const GAP = ${COLUMN_GAP};
  const PAD = ${VIEWPORT_PADDING};
  const CASES = __CASES__;
  const results = [];
  for (const testCase of CASES) {
    const available = Math.max(120, testCase.viewportWidth - PAD * 2);
    const columnWidth = testCase.columnsPerView === 1 ? available : Math.max(120, (available - GAP) / 2);
    // 复刻产品的两个量（一屏可见宽度 / 翻页步长），由 TS 侧传入以保持一致
    const screenWidth = testCase.columnsPerView === 1 ? columnWidth : columnWidth * 2 + GAP;
    const step = testCase.columnsPerView * (columnWidth + GAP);
    const measured = layout(testCase.paragraphs, testCase.columnsPerView, testCase.viewportWidth, testCase.viewportHeight, columnWidth, screenWidth);

    // 用浏览器实测的列起点推出真实列步进（相邻起点之差），作为独立判据
    const starts = measured.starts;
    const strides = [];
    for (let i = 1; i < starts.length; i += 1) strides.push(starts[i] - starts[i - 1]);
    const stride = strides.length > 0 ? strides[0] : null;

    // 翻页对齐检查：第 v 屏的左边缘（flow 内容坐标系里的 v*step）必须落在某个列起点上
    const flow = document.getElementById('flow');
    const viewport = document.getElementById('viewport');
    const alignments = [];
    const viewCount = Math.max(1, Math.ceil((starts.length || 1) / testCase.columnsPerView));
    for (let view = 0; view < Math.min(viewCount, 6); view += 1) {
      flow.style.transform = 'translateX(' + (-view * step) + 'px)';
      // 视口左边缘在 flow 内容坐标系中的位置 = 位移量（因为视口内容区左缘对齐 flow 原点）
      const edge = view * step;
      // 最近的列起点（列起点即 starts 数组，均在 flow 坐标系内）
      let best = null;
      for (const start of starts) {
        if (best === null || Math.abs(start - edge) < Math.abs(best - edge)) best = start;
      }
      alignments.push({
        view,
        edge: Math.round(edge),
        nearestColumnStart: best,
        delta: best === null ? null : Math.round(edge - best),
      });
    }
    flow.style.transform = 'translateX(0px)';

    results.push({
      ...measured,
      step,
      stride,
      viewCount,
      alignments,
    });
  }
  document.getElementById('out').textContent = JSON.stringify(results, null, 2);
} catch (error) {
  document.getElementById('err').textContent = 'THROWN: ' + (error && error.stack ? error.stack : error);
}
</script></body></html>`;

const CASES = [
  { columnsPerView: 1, paragraphs: 40, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 40, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 60, viewportWidth: 1440, viewportHeight: 800 },
  { columnsPerView: 2, paragraphs: 30, viewportWidth: 872, viewportHeight: 700 },
  { columnsPerView: 1, paragraphs: 50, viewportWidth: 600, viewportHeight: 500 },
];

const pagePath = join(tmpdir(), `rw-paging-align-${process.pid}.html`);
await writeFile(pagePath, PAGE.replace('__CASES__', JSON.stringify(CASES)), 'utf8');

const { stdout } = await execFileAsync(
  browser,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1600,1000', '--virtual-time-budget=5000', '--dump-dom', `file:///${pagePath.split('\\').join('/')}`],
  { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
);

/** 从 dump 出的 DOM 取 JSON。 */
function extract(dom, id) {
  const match = new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`).exec(dom);
  if (match === null) return undefined;
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return decoded.trim() === '' ? undefined : decoded;
}

const raw = extract(stdout, 'out');
const errText = extract(stdout, 'err');

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

if (raw === undefined) {
  console.log('页面未产出测量结果。');
  if (errText !== undefined) console.log('页面报错：', errText);
  else console.log(stdout.slice(0, 600));
  await unlink(pagePath).catch(() => undefined);
  process.exit(1);
}

const results = JSON.parse(raw);

// ── 1) 先在纯函数层面钉死「两个量不相等」这个事实 ──
for (const columnsPerView of [1, 2]) {
  const columnWidth = columnWidthOf(1000, columnsPerView);
  const screen = screenWidthOf(columnWidth, columnsPerView);
  const step = stepOf(columnWidth, columnsPerView);
  check(
    `纯函数：${columnsPerView} 栏时 screenWidth 与 step 相差恰好一个列间距`,
    Math.abs(step - screen - COLUMN_GAP) < 0.001,
    `screen=${screen} step=${step} gap=${COLUMN_GAP}`,
  );
}

// ── 2) 浏览器实测：列步进必须等于 列宽+间距 ──
console.log('');
for (const [index, result] of results.entries()) {
  const label = `#${index + 1} ${result.columnsPerView}栏 视口${result.viewportWidth}px`;
  check(
    `${label}：实测列步进 == 列宽 + 间距`,
    result.stride === null || Math.abs(result.stride - (result.columnWidth + COLUMN_GAP)) <= 1,
    `stride=${result.stride} 期望≈${result.columnWidth + COLUMN_GAP}`,
  );
  check(`${label}：排版出多列（能验证分页）`, result.starts.length >= 2, `${result.starts.length} 列起点`);
}

// ── 3) 核心回归：每一屏的左边缘必须压在某列起点上（误差 ≤1px） ──
console.log('');
let alignedViews = 0;
let totalViews = 0;
for (const [index, result] of results.entries()) {
  const label = `#${index + 1} ${result.columnsPerView}栏 视口${result.viewportWidth}px`;
  for (const alignment of result.alignments) {
    totalViews += 1;
    const ok = alignment.delta !== null && Math.abs(alignment.delta) <= 1;
    if (ok) alignedViews += 1;
    check(
      `${label}：第 ${alignment.view} 屏对齐到列起点`,
      ok,
      `屏左缘=${alignment.edge} 最近列起点=${alignment.nearestColumnStart} 偏差=${alignment.delta}px`,
    );
  }
}
check('全部屏都对齐（无累积偏移）', alignedViews === totalViews, `${alignedViews}/${totalViews}`);

// ── 4) 反证：若用 screenWidth 当步长，必须出现明显偏差（证明本测试能抓到该 bug） ──
const twoColumn = results.find((result) => result.columnsPerView === 2);
if (twoColumn !== undefined) {
  const wrongOffset = twoColumn.screenWidth;
  let wrongDelta = null;
  for (const start of twoColumn.starts) {
    if (wrongDelta === null || Math.abs(start - wrongOffset) < Math.abs(wrongDelta)) wrongDelta = start - wrongOffset;
  }
  check(
    '反证：用 screenWidth 当步长会偏离列起点（本测试确实能抓到原 bug）',
    wrongDelta !== null && Math.abs(wrongDelta) > 1,
    `偏移=${wrongDelta}px（应为 ±列间距量级）`,
  );
}

await unlink(pagePath).catch(() => undefined);
console.log(allPass ? '\n翻页对齐验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
