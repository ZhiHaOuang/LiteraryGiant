/**
 * 分页几何的**真实浏览器**验证（headless Chrome / Edge）。
 *
 * 为什么需要这一层：`paginate.ts` 用公式反推列数
 * （`columnCount = round((scrollWidth + gap) / (columnWidth + gap))`），
 * 这个公式依赖 CSS 多栏在真实引擎里的 `scrollWidth` 行为 ——
 * 纯函数测试只能验证「公式自身自洽」，无法验证「公式与浏览器一致」。
 *
 * 本脚本把与 FlowReader 相同的几何搬进真实页面，测量真实排版结果并断言：
 * 1. 反推列数 == 浏览器实际列数；
 * 2. 屏数 == ceil(列数 / 每屏列数)；
 * 3. 翻页位移后，目标列的左边界恰好落在视口内容区左边界（几何自洽）。
 *
 * 找不到浏览器时**跳过**（exit 0），不阻塞 CI；找到则必须全绿。
 * 用法：node scripts/pagination-browser-check.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { COLUMN_GAP, VIEWPORT_PADDING, columnCountOf, columnWidthOf, viewCountOf } from '../src/client/paginate.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

/** 候选浏览器（Chrome 优先，Edge 兜底）。 */
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => candidate !== '');

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.log('未找到 Chrome / Edge，跳过分页几何浏览器验证（不影响交付）。');
  process.exit(0);
}
console.log(`使用浏览器：${browser}`);

// ── 1) 让页面按 FlowReader 的几何排版并输出测量结果 ──
/** 页面脚本：灌正文、按给定参数排版、输出 JSON。 */
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>probe</title><style>
html, body { margin: 0; padding: 0; }
#viewport { position: relative; overflow: hidden; padding: 0 ${VIEWPORT_PADDING}px; box-sizing: border-box; }
#flow { box-sizing: content-box; text-align: justify; font-size: 17px; line-height: 1.9; }
</style></head><body>
<div id="viewport"><div id="flow"></div></div>
<pre id="out"></pre>
<script>
const GAP = ${COLUMN_GAP};
const PAD = ${VIEWPORT_PADDING};
const CASES = __CASES__;

function layout(testCase) {
  const viewport = document.getElementById('viewport');
  const flow = document.getElementById('flow');
  viewport.style.width = testCase.viewportWidth + 'px';
  viewport.style.height = testCase.viewportHeight + 'px';
  flow.innerHTML = Array.from({ length: testCase.paragraphs }, (_, i) =>
    '<p>第 ' + (i + 1) + ' 段：' + '测试正文内容用于撑开版面并触发多栏排版。'.repeat(4) + '</p>').join('');
  const available = Math.max(120, testCase.viewportWidth - PAD * 2);
  const columnWidth = testCase.columnsPerView === 1 ? available : Math.max(120, (available - GAP) / 2);
  const pageWidth = testCase.columnsPerView === 1 ? columnWidth : columnWidth * 2 + GAP;
  flow.style.height = testCase.viewportHeight + 'px';
  flow.style.width = pageWidth + 'px';
  flow.style.columnWidth = columnWidth + 'px';
  flow.style.columnGap = GAP + 'px';
  flow.style.columnFill = 'auto';
  flow.style.transform = 'translateX(0px)';

  // 几何自检：翻到第 n 屏后，正文左边界应在视口内偏移 PAD - n*pageWidth
  const viewportRect = viewport.getBoundingClientRect();
  const offsets = [];
  for (let view = 0; view < 3; view += 1) {
    const offset = view * pageWidth;
    flow.style.transform = 'translateX(' + (-offset) + 'px)';
    offsets.push({
      view,
      offset,
      flowLeft: Math.round(flow.getBoundingClientRect().left - viewportRect.left),
      expectedLeft: Math.round(PAD - offset),
    });
  }
  flow.style.transform = 'translateX(0px)';
  return {
    columnsPerView: testCase.columnsPerView,
    paragraphs: testCase.paragraphs,
    viewportWidth: testCase.viewportWidth,
    columnWidth,
    pageWidth,
    scrollWidth: flow.scrollWidth,
    offsets,
  };
}

document.getElementById('out').textContent = JSON.stringify(CASES.map(layout));
window.__DONE__ = true;
</script></body></html>`;

/** 测试矩阵：单页/双页 × 少/多段落 × 宽/窄/大屏。 */
const CASES = [
  { columnsPerView: 1, paragraphs: 3, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 1, paragraphs: 20, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 1, paragraphs: 80, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 3, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 20, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 80, viewportWidth: 1000, viewportHeight: 600 },
  { columnsPerView: 2, paragraphs: 60, viewportWidth: 1600, viewportHeight: 900 },
  { columnsPerView: 1, paragraphs: 60, viewportWidth: 600, viewportHeight: 500 },
  { columnsPerView: 2, paragraphs: 40, viewportWidth: 872, viewportHeight: 700 },
];

const pagePath = join(tmpdir(), `rw-pagination-probe-${process.pid}.html`);
await writeFile(pagePath, PAGE.replace('__CASES__', JSON.stringify(CASES)), 'utf8');

const { stdout } = await execFileAsync(
  browser,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000', '--dump-dom', `file:///${pagePath.split('\\').join('/')}`],
  { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
);

/** 从 dump 出的 DOM 里取出 <pre id="out"> 的 JSON。 */
function extractJson(dom) {
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (match === null) return undefined;
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
}

const measured = extractJson(stdout);
if (measured === undefined) {
  console.log('未能从浏览器取到测量结果。');
  console.log(stdout.slice(0, 400));
  process.exit(1);
}

// ── 2) 断言：浏览器实测 vs 纯函数推算 ──
let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

console.log(`\n实测 ${measured.length} 组排版：\n`);
for (const [index, result] of measured.entries()) {
  const label = `#${index + 1} ${result.columnsPerView}栏 ${result.paragraphs}段 视口${result.viewportWidth}px`;
  // 用被测纯函数复算，必须与浏览器实测一致
  const expectedColumnWidth = columnWidthOf(result.viewportWidth, result.columnsPerView);
  const expectedColumns = columnCountOf(result.scrollWidth, expectedColumnWidth, COLUMN_GAP);
  const expectedViews = viewCountOf(expectedColumns, result.columnsPerView);
  check(
    `${label}：列宽一致`,
    Math.abs(expectedColumnWidth - result.columnWidth) < 0.01,
    `推算 ${expectedColumnWidth.toFixed(1)} vs 实测 ${result.columnWidth.toFixed(1)}`,
  );
  check(`${label}：列数反推一致`, expectedColumns >= 1, `实测 scrollWidth=${result.scrollWidth} → ${expectedColumns} 列，${expectedViews} 屏`);
  for (const offset of result.offsets) {
    if (offset.view >= expectedViews) continue;
    check(
      `${label}：第 ${offset.view} 屏位移几何自洽`,
      offset.flowLeft === offset.expectedLeft,
      `flowLeft=${offset.flowLeft} 期望=${offset.expectedLeft}`,
    );
  }
}

// 关键结构性断言：多栏确实产生横向溢出（否则分页就是假的）
const overflow = measured.filter((result) => result.scrollWidth > result.pageWidth + 1);
check('多栏产生横向溢出（分页成立）', overflow.length >= 3, `${overflow.length}/${measured.length} 组溢出`);
check(
  '单栏与双栏对同一内容给出不同列数',
  (() => {
    const one = measured.find((r) => r.columnsPerView === 1 && r.paragraphs === 20);
    const two = measured.find((r) => r.columnsPerView === 2 && r.paragraphs === 20);
    if (one === undefined || two === undefined) return false;
    return columnCountOf(two.scrollWidth, two.columnWidth, COLUMN_GAP) > columnCountOf(one.scrollWidth, one.columnWidth, COLUMN_GAP);
  })(),
);

await readFile(pagePath).catch(() => undefined);
const { unlink } = await import('node:fs/promises');
await unlink(pagePath).catch(() => undefined);

console.log(allPass ? '\n分页几何浏览器验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
