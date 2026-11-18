/**
 * TXT 重排版在**真实浏览器**里的几何验证（headless Chrome / Edge）。
 *
 * 为什么需要这一层：纯函数测试只能证明「layoutTxt 按规则切了段」，
 * 证明不了「这些 p 元素在真实排版引擎里真的表现出段间距 / 首行缩进 /
 * 折行按容器宽度重排」。而 text-indent 是否生效、段落是否被
 * break-inside: avoid 卡住（P1 踩过的坑）、多栏下是否正常断开，
 * 都只有真实引擎说了算。
 *
 * 本脚本把与 ReaderView + FlowReader 相同的 DOM 结构与**同一份 STYLES**
 * 搬进真实页面，测量真实排版结果并断言。两条关键证据：
 * 1. **同一段文本在窄容器里的行数多于宽容器** —— 决定性证明浏览器是按容器
 *    宽度重排，而不是保留了源文件的换行（源文件行宽固定时，后者行数不随容器变）；
 * 2. **对照实验**：同一段文本用旧的 pre + pre-wrap 写法渲染时行数 = 源文件行数，
 *    新渲染则不同 —— 证明行为确实变了。
 *
 * 找不到浏览器时跳过（exit 0）；找到则必须全绿。
 * 用法：node scripts/txt-reflow-browser-check.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { layoutTxt } from '../src/client/txt-layout.ts';
import { STYLES } from '../src/client/styles.ts';
import { COLUMN_GAP, VIEWPORT_PADDING } from '../src/client/paginate.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((candidate) => candidate !== '');
const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.log('未找到 Chrome / Edge，跳过 TXT 重排浏览器验证（不影响交付）。');
  process.exit(0);
}

// ── 1) 合成样本（**不含任何真实书籍内容**）──
/**
 * 折行型：`lineCount` 行、每行 `charsPerLine` 字，段首全角缩进，行尾多为逗号。
 * 行长故意取 20 字（明显窄于阅读器列宽），这样「合并后按容器重排」才与源文件行数不同。
 */
function hardWrapped(lineCount, charsPerLine) {
  const pool = '曙光初露繁忙的大都市又开始活跃起来展开了五光十色的新一天人来人往车水马龙';
  const body = pool.repeat(4);
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    const head = i === 0 ? '\u3000\u3000' : '';
    const content = body.slice(0, charsPerLine - head.length - 1);
    const tail = i === lineCount - 1 ? '。' : '，';
    lines.push(head + content + tail);
  }
  return lines.join('\r\n') + '\r\n';
}
/** 短段型：每行一个完整短段（28 字，**行尾必须是句号**），保证在阅读器列宽下一段一行。 */
const SHORT_PARAS = ['春天的风轻轻吹过窗台', '他把书合上放在桌角边', '雨点打在玻璃上作响']
  .map((line) => line.padEnd(27, '好') + '。')
  .join('\r\n');
const DIALOGUE = '「我等你。」\r\n「好。」\r\n';
const NO_BREAK = '这是一段没有任何换行的超长正文用来触发兜底切段逻辑。'.repeat(60) + '\r\n';

const HARD_LINES = 12;
const cases = {
  hard: { text: hardWrapped(HARD_LINES, 20), expectedParas: 1, rawLines: HARD_LINES },
  short: { text: SHORT_PARAS, expectedParas: 3, rawLines: 3 },
  dialogue: { text: DIALOGUE, expectedParas: 2, rawLines: 2 },
  noBreak: { text: NO_BREAK, expectedParas: -1, rawLines: 1 },
};
for (const [key, value] of Object.entries(cases)) {
  const layout = layoutTxt(value.text);
  value.html = layout.html;
  const count = layout.paragraphs.length;
  if (value.expectedParas >= 0 && count !== value.expectedParas) {
    console.log(`FAIL  样本 ${key} 的纯函数段数就与预期不符：${count} vs ${value.expectedParas}`);
    process.exit(1);
  }
  value.expectedParas = count;
}

// ── 2) 页面：与 FlowReader 相同的结构与 STYLES，外加对照组 ──
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>txt-reflow probe</title><style>
html, body { margin: 0; padding: 0; }
${STYLES.replace(/<\/style/gi, '<\\/style')}
</style></head><body>
<div id="stage"></div>
<pre id="out"></pre>
<script>
const CASES = __CASES__;
const PAD = ${VIEWPORT_PADDING};
const GAP = ${COLUMN_GAP};

/** 按 FlowReader 的几何搭容器，返回 flow 元素。 */
function mount(host, html, width, fontSize, twoColumn) {
  const viewport = document.createElement('div');
  viewport.className = 'dsh-reading-viewport';
  viewport.style.width = width + 'px';
  viewport.style.height = '900px';
  viewport.style.padding = '0 ' + PAD + 'px';
  const flow = document.createElement('div');
  flow.className = 'dsh-reading-flow dsh-reading-flow-plain';
  const available = width - PAD * 2;
  const columnWidth = twoColumn ? Math.max(120, (available - GAP) / 2) : available;
  const screenWidth = twoColumn ? columnWidth * 2 + GAP : columnWidth;
  flow.style.width = screenWidth + 'px';
  flow.style.height = '900px';
  flow.style.columnWidth = columnWidth + 'px';
  flow.style.columnGap = GAP + 'px';
  flow.style.columnFill = 'auto';
  flow.style.fontSize = fontSize + 'px';
  flow.style.lineHeight = '1.9';
  flow.innerHTML = html;
  host.appendChild(viewport);
  viewport.appendChild(flow);
  return flow;
}

/** 测量一个元素的渲染行数（Range 的行框数量）。 */
function lineCountOf(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getClientRects().length;
}

/**
 * 量 pre 的渲染行数：pre 内含真实换行符，Range 的 rect 数会翻倍
 * （每个换行另占一个空框），所以对照组改用内容高度推算。
 */
function preLineCount(pre) {
  const cs = getComputedStyle(pre);
  const inner = pre.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return Math.round(inner / parseFloat(cs.lineHeight));
}

/** 采集一个 flow 的排版结果。 */
function measure(flow) {
  const ps = Array.from(flow.querySelectorAll('p'));
  return {
    paragraphCount: ps.length,
    preCount: flow.querySelectorAll('pre').length,
    scrollWidth: flow.scrollWidth,
    clientWidth: flow.clientWidth,
    paragraphs: ps.map((p) => {
      const cs = getComputedStyle(p);
      return {
        chars: p.textContent.length,
        lineCount: lineCountOf(p),
        textIndent: cs.textIndent,
        marginBottom: cs.marginBottom,
        breakInside: cs.breakInside,
      };
    }),
  };
}

/** 造一个与旧写法一致的 pre 元素。 */
function makeLegacyPre() {
  const pre = document.createElement('pre');
  pre.className = 'dsh-reading-plain';
  pre.style.margin = '0';
  pre.style.background = 'none';
  pre.style.border = '0';
  pre.style.padding = '0';
  pre.style.borderRadius = '0';
  pre.style.overflow = 'visible';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  pre.style.fontFamily = 'inherit';
  return pre;
}

const stage = document.getElementById('stage');
const result = {};
/** 挂一个新容器并测量。 */
function run(key, html, width, fontSize, twoColumn) {
  const host = document.createElement('div');
  stage.appendChild(host);
  result[key] = measure(mount(host, html, width, fontSize, twoColumn === true));
}

// 新渲染：四个样本各挂一个容器（单栏，620px 约每行 32 字）
for (const key of Object.keys(CASES)) run(key, CASES[key].html, 620, 17, false);
// 窄容器：同一段折行文本，用来证明「行数由容器宽度决定」
run('hardNarrow', CASES.hard.html, 400, 17, false);
// 双栏
run('hardTwoColumn', CASES.hard.html, 980, 17, true);
// 大字：验证缩进随字号缩放（2em 语义，而不是写死像素）
run('hardBigFont', CASES.hard.html, 620, 24, false);

// 对照组 A：同一段文本用旧的 pre + pre-wrap 渲染，原文保持 CRLF
{
  const host = document.createElement('div');
  stage.appendChild(host);
  const flow = mount(host, '', 620, 17, false);
  const pre = makeLegacyPre();
  pre.innerHTML = CASES.hard.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  flow.appendChild(pre);
  result.legacyPre = { lineCount: preLineCount(pre), text: pre.textContent.length };
}
// 对照组 B：同一段文本把 CRLF 规范成 LF 后走旧写法，
// 用来剥离「CRLF 在 pre-wrap 下占几个换行」这个干扰项
{
  const host = document.createElement('div');
  stage.appendChild(host);
  const flow = mount(host, '', 620, 17, false);
  const pre = makeLegacyPre();
  const lf = CASES.hard.text.split('\\r\\n').join('\\n');
  pre.innerHTML = lf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  flow.appendChild(pre);
  result.legacyPreLf = { lineCount: preLineCount(pre), text: pre.textContent.length };
}

document.getElementById('out').textContent = JSON.stringify(result);
</script></body></html>`;

const pagePath = join(tmpdir(), `dsh-txt-reflow-probe-${Date.now()}.html`);
await writeFile(pagePath, PAGE.replace('__CASES__', JSON.stringify(
  Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, { html: value.html, text: value.text }])),
)), 'utf8');

const fileUrl = `file:///${pagePath.split('\\').join('/')}`;
const { stdout } = await execFileAsync(
  browser,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=5000', '--dump-dom', fileUrl],
  { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
);

/** 从 dump 出的 DOM 里取出 out 元素的 JSON。 */
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
  console.log(stdout.slice(0, 600));
  process.exit(1);
}

// ── 3) 断言 ──
let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

console.log(`\n浏览器：${browser}\n`);
const INDENT_17 = '34px';
const INDENT_24 = '48px';
const MARGIN = '9.35px';
const hardLines = measured.hard.paragraphs[0].lineCount;
const narrowLines = measured.hardNarrow.paragraphs[0].lineCount;

check('折行型：合并成 1 段', measured.hard.paragraphCount === 1, `段数 ${measured.hard.paragraphCount}`);
check('折行型：无残留 pre 元素', measured.hard.preCount === 0, `pre 数 ${measured.hard.preCount}`);
check('折行型：渲染行数 ≠ 源文件行数（不再是原样换行）',
  hardLines !== HARD_LINES,
  `渲染 ${hardLines} 行 vs 源文件 ${HARD_LINES} 行`);
check('★ 折行型：窄容器行数 > 宽容器行数（按容器宽度重排的决定性证据）',
  narrowLines > hardLines,
  `窄 400px → ${narrowLines} 行  vs  宽 620px → ${hardLines} 行`);

check('短段型：保持 3 段', measured.short.paragraphCount === 3, `段数 ${measured.short.paragraphCount}`);
check('短段型：每段恰好渲染 1 行',
  measured.short.paragraphs.every((row) => row.lineCount === 1),
  measured.short.paragraphs.map((row) => row.lineCount).join('/'));

check('对白型：切成 2 段', measured.dialogue.paragraphCount === 2, `段数 ${measured.dialogue.paragraphCount}`);
check('无换行型：触发兜底切段（> 1 段）', measured.noBreak.paragraphCount > 1, `段数 ${measured.noBreak.paragraphCount}`);
check('无换行型：每段 ≤ 800 字',
  measured.noBreak.paragraphs.every((row) => row.chars <= 800),
  `最长 ${Math.max(...measured.noBreak.paragraphs.map((row) => row.chars))} 字`);

const all = [measured.hard, measured.short, measured.dialogue, measured.noBreak];
check('首行缩进 = 2em（17px 字号下 34px）',
  all.every((flow) => flow.paragraphs.every((row) => row.textIndent === INDENT_17)),
  `实测 ${measured.hard.paragraphs[0].textIndent}`);
check('段间距 = 0.55em（17px 字号下 9.35px）',
  all.every((flow) => flow.paragraphs.every((row) => row.marginBottom === MARGIN)),
  `实测 ${measured.hard.paragraphs[0].marginBottom}`);
check('缩进随字号缩放（24px 字号下 48px = 2em 语义）',
  measured.hardBigFont.paragraphs[0].textIndent === INDENT_24,
  `实测 ${measured.hardBigFont.paragraphs[0].textIndent}`);
check('段落可跨列断开（break-inside 必须是 auto，P1 踩过的坑）',
  all.every((flow) => flow.paragraphs.every((row) => row.breakInside === 'auto')),
  `实测 ${measured.hard.paragraphs[0].breakInside}`);
check('双栏：排版正常（scrollWidth 大于一列宽）',
  measured.hardTwoColumn.scrollWidth > measured.hardTwoColumn.clientWidth / 2,
  `scrollWidth=${measured.hardTwoColumn.scrollWidth} clientWidth=${measured.hardTwoColumn.clientWidth}`);
check('双栏：双栏下首行缩进仍生效',
  measured.hardTwoColumn.paragraphs[0].textIndent === INDENT_17,
  `实测 ${measured.hardTwoColumn.paragraphs[0].textIndent}`);

// ── 4) 对照实验：旧写法 vs 新写法 ──
check('对照：旧写法（CRLF 源文件）渲染行数 = 源文件行数',
  measured.legacyPre.lineCount === HARD_LINES,
  `旧 ${measured.legacyPre.lineCount} 行 vs 源文件 ${HARD_LINES} 行`);
check('对照：旧写法把 CRLF 与 LF 当同样多行（换行规范化不影响行数）',
  measured.legacyPre.lineCount === measured.legacyPreLf.lineCount,
  `CRLF ${measured.legacyPre.lineCount} 行 vs LF ${measured.legacyPreLf.lineCount} 行`);
check('对照：新渲染行数 ≠ 旧渲染行数（行为确已改变）',
  hardLines !== measured.legacyPre.lineCount,
  `新 ${hardLines} 行 vs 旧 ${measured.legacyPre.lineCount} 行`);

// ── 5) 截图留证 ──
const shotPath = join(projectRoot, '..', '..', 'docs', 'txt-reflow-browser.png');
try {
  await execFileAsync(
    browser,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1100,1400',
      '--virtual-time-budget=3000', `--screenshot=${shotPath}`, fileUrl],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  console.log(`\n截图已写入：${shotPath}`);
} catch {
  console.log('\n截图失败（不影响断言结论）。');
}

console.log(`\n${allPass ? 'TXT 重排浏览器验证全部通过' : 'TXT 重排浏览器验证存在失败项'}`);
process.exit(allPass ? 0 : 1);
