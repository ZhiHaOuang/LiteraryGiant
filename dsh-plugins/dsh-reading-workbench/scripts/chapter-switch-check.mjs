/**
 * 换章导航的组件级回归测试（真实 ReaderView + jsdom + 真实 keydown / change / click）。
 *
 * 覆盖三组用例，每组都对应一个**已确认**的真缺陷或新契约：
 *
 * 1. **M8 加载期连按跳章**（反证）：`goChapter` 换章时不复位 `pagination`，而 `nextPage`
 *    用 `navRef.viewCount`（仍是上一章屏数）判边界。上一章只有 1 屏时，在换章加载中
 *    再按一次「下一页」→ `target(1) >= viewCount(1)` → 直接再换一章，**整章被跳过**。
 *    修复前该用例失败（chapterIndex 前进 2、正文停在第 3 章、发出了第 3 章请求）。
 * 2. **M9 换章响应无代际校验**（反证）：快速换章时旧请求后到会覆盖新章正文
 *    （正文是 A 章、章号与进度是 B 章）。修复前该用例失败（正文停在上一章）。
 * 3. **skip 章契约**：`EpubChapter.skip` 标记的「纯标题页 / 分节页」内容已并入下一章，
 *    目录不展示、翻页与换章都要跳过它，且 `index` 保持原样（进度/划线锚点不受影响）。
 *
 * 实现要点（复用 reader-keyboard-check.mjs 的转译/挂载链路）：
 * jsdom 没有布局引擎，`clientWidth/scrollWidth` 恒为 0，所以对测量属性打桩，
 * 并让 `scrollWidth` 可调 —— 屏数由本脚本控制（1 屏 / N 屏），便于构造 M8 的
 * 「上一章只有 1 屏」前提。
 *
 * 用法：node scripts/chapter-switch-check.mjs
 */
import { JSDOM } from 'jsdom';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const srcRoot = join(pluginRoot, 'src');
const require = createRequire(import.meta.url);

// ── 0) 钉住唯一的 react 实例（react-dom 解析到的那份）──
const reactDomEntry = require.resolve('react-dom/server');
const reactDomClientEntry = require.resolve('react-dom/client');
const sharedRequire = createRequire(reactDomEntry);
const reactEntry = sharedRequire.resolve('react');
const reactJsxEntry = sharedRequire.resolve('react/jsx-runtime');

/** 把裸 react 导入改写为唯一实例的绝对路径。 */
function pinReact(code) {
  return code.replace(
    /(from\s+|import\s*\(\s*)(['"])(react(?:\/jsx-runtime)?|react-dom(?:\/client)?)\2/g,
    (match, prefix, quote, spec) => {
      const target =
        spec === 'react' ? reactEntry
        : spec === 'react/jsx-runtime' ? reactJsxEntry
        : spec === 'react-dom/client' ? reactDomClientEntry
        : reactDomEntry;
      return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
    },
  );
}

// ── 1) 转译依赖图 ──
const outParent = join(pluginRoot, 'node_modules', '.cache');
await mkdir(outParent, { recursive: true });
for (const stale of await readdir(outParent).catch(() => [])) {
  if (stale.startsWith('rw-chsw-')) await rm(join(outParent, stale), { recursive: true, force: true });
}
const outRoot = await mkdtemp(join(outParent, 'rw-chsw-'));
process.on('exit', () => {
  try {
    rmSync(outRoot, { recursive: true, force: true });
  } catch {
    /* 退出阶段清理失败无需上报 */
  }
});

/** 源文件 → 转译产物路径。 */
function outPathOf(sourceFile) {
  return join(outRoot, relative(srcRoot, sourceFile).replace(/\.tsx?$/, '.js'));
}

/** 递归转译依赖图。 */
async function transpileGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const output = ts.transpileModule(await readFile(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        verbatimModuleSyntax: false,
      },
      fileName: file,
    }).outputText;
    const outPath = outPathOf(file);
    const rewritten = pinReact(
      output.replace(/(from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\2/g, (match, prefix, quote, spec) => {
        const resolved = resolve(dirname(file), spec);
        const target = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`].find((candidate) => existsSync(candidate));
        if (target === undefined) return match;
        if (target.endsWith('.ts') || target.endsWith('.tsx')) queue.push(target);
        const rel = relative(dirname(outPath), outPathOf(target)).split(sep).join('/');
        return `${prefix}${quote}${rel.startsWith('.') ? rel : `./${rel}`}${quote}`;
      }),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rewritten, 'utf8');
  }
}

await transpileGraph([join(srcRoot, 'client/panel/ReaderView.tsx'), join(srcRoot, 'client/locales.ts')]);
await writeFile(join(outRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

// ── 2) jsdom + 测量打桩 ──
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 600;
const COLUMN_GAP = 48;
const PADDING = 32;
/** columns=1 → 单屏 1 列；列宽 = 视口内容宽。 */
const COLUMN_WIDTH = VIEWPORT_WIDTH - PADDING * 2; // 936
/**
 * 可调内容总宽：由用例决定「上一章有几屏」。
 * 1 屏 = 恰好一列宽；N 屏 = N 列 × 列宽 + (N-1) 个间距（与 paginate.columnCountOf 互逆）。
 */
const layout = { scrollWidth: COLUMN_WIDTH };
const widthForScreens = (screens) => screens * COLUMN_WIDTH + (screens - 1) * COLUMN_GAP;

function installLayoutStubs() {
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-viewport') ? VIEWPORT_WIDTH : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-viewport') ? VIEWPORT_HEIGHT : 0;
    },
  });
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-flow') ? layout.scrollWidth : 0;
    },
  });
  // jsdom 无 ResizeObserver：立即回调一次即可完成首测
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      this.callback([]);
    }
    unobserve() {}
    disconnect() {}
  };
}

installLayoutStubs();

globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDivElement = window.HTMLDivElement;
globalThis.ResizeObserver = window.ResizeObserver;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
if (globalThis.performance === undefined) globalThis.performance = window.performance;

// ── 3) 挂载真实 ReaderView ──
const { createElement } = await import(pathToFileURL(reactEntry).href);
const { createRoot } = await import(pathToFileURL(reactDomClientEntry).href);
const { ReaderView } = await import(pathToFileURL(join(outRoot, 'client/panel/ReaderView.js')).href);
const { zh } = await import(pathToFileURL(join(outRoot, 'client/locales.js')).href);
const t = (key) => zh[key] ?? key;

/** 等若干轮事件循环，让异步 effect 收敛。 */
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
/** 真等一段时间（mock 的换章延迟按毫秒计）。 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const book = {
  id: 'b-switch',
  title: '换章导航测试书',
  author: '测试',
  sourcePath: 'upload:b.epub',
  format: 'epub',
  addedAt: 1,
  hasCover: false,
};

/**
 * 造一批章节 + 假 API + 挂载。返回的 `requested` 记录**发出请求的章序**（含被丢弃的），
 * 用来断言「有没有多请求一章」。
 *
 * @param {object} spec
 * @param {Array<{index: number, title: string, href: string, skip?: boolean}>} spec.chapters 目录
 * @param {(index: number) => number} spec.delay 各章请求延迟（毫秒）
 * @param {(index: number) => string} spec.html 各章正文 HTML
 */
async function mountCase({ chapters, delay, html }) {
  const requested = [];
  let container;
  const api = {
    toc: async () => ({ book, chapters }),
    chapter: async (_bookId, index) => {
      requested.push(index);
      const ms = delay(index);
      if (ms > 0) await wait(ms);
      return { book, chapter: chapters[index], html: html(index), chapterCount: chapters.length };
    },
    bookStyles: async () => ({ css: '', files: [], warnings: [] }),
    content: async () => ({ book, content: '' }),
    assetUrl: (id, path) => `asset?${id}&${path}`,
    fileUrl: (id) => `file?${id}`,
    saveProgress: async () => ({ saved: true }),
    listHighlights: async () => [],
    createHighlight: async () => ({ id: 'x', bookId: book.id, text: '', anchor: '', createdAt: 0 }),
    updateHighlightNote: async () => ({ id: 'x', bookId: book.id, text: '', anchor: '', createdAt: 0 }),
    deleteHighlight: async () => ({ removed: true }),
    webSourceStatus: async () => ({
      bookId: book.id,
      total: 0,
      fetched: 0,
      pending: 0,
      errors: [],
      fetchedIndexes: [],
    }),
  };
  container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    createElement(ReaderView, {
      api,
      t,
      book,
      settings: {
        fontSize: 17,
        lineHeight: 1.9,
        theme: 'follow',
        columns: 1,
        txtReflow: 'auto',
        bookCss: 'book',
        fontFamily: 'system',
      },
      progress: undefined,
      onSettingsChange: () => {},
      onBack: () => {},
    }),
  );
  await settle(20);

  return {
    container,
    root,
    requested,
    async cleanup() {
      root.unmount();
      await settle(2);
      container.remove();
    },
  };
}

/** 当前章序（读目录下拉的受控 value：换章完成/加载中都能读到真实 state）。 */
function readChapterIndex(container) {
  const select = container.querySelector('.dsh-reading-chapterselect');
  if (select === null) return undefined;
  return Number(select.value);
}

/** 当前正文纯文本（加载中为 ''）。 */
function readFlowText(container) {
  const flow = container.querySelector('.dsh-reading-flow');
  return flow === null ? '' : flow.textContent ?? '';
}

/** 页码文本（形如「章节 2/5 · 1/1 页」）；加载中没有页码。 */
function readPager(container) {
  const element = container.querySelector('.dsh-reading-pager');
  return element === null ? '' : element.textContent ?? '';
}

/** 从页码文本解析出 { chapter, unitCount, view, viewCount }。 */
function parsePager(text) {
  const match = /(\d+)\s*\/\s*(\d+)\s*·\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  if (match === null) return undefined;
  return {
    chapter: Number(match[1]),
    unitCount: Number(match[2]),
    view: Number(match[3]),
    viewCount: Number(match[4]),
  };
}

/** 派发一次真实 keydown。 */
function pressKey(key) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
}

/** 通过目录下拉换章（受控 <select> 的 change 走 React onChange）。 */
function selectChapter(container, index) {
  const select = container.querySelector('.dsh-reading-chapterselect');
  if (select === null) throw new Error('目录下拉不存在，无法选择章节');
  select.value = String(index);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** 点击正文里的章内链接（data-dsh-chapter-link）。 */
function clickChapterLink(container) {
  const link = container.querySelector('a[data-dsh-chapter-link]');
  if (link === null) throw new Error('正文里没有章内链接');
  link.click();
}

/** 读目录下拉里的全部选项（value + 显示文本）。 */
function readOptions(container) {
  const select = container.querySelector('.dsh-reading-chapterselect');
  if (select === null) return [];
  return Array.from(select.querySelectorAll('option')).map((option) => ({
    value: option.value,
    text: option.textContent ?? '',
  }));
}

/** 正文 HTML：每章都可点一条指向「分节页」的链接，用于验证 goChapter 的落点纠偏。 */
const chapterHtml = (index) =>
  `<p>第${index + 1}章正文</p><p>（用于校验换章落点）</p>` +
  `<p><a data-dsh-chapter-link="ch3.xhtml" href="#skip">跳到分节页</a></p>`;

// ═══════════════════════════════════════════════════════════════════════════
// 用例 1（反证 M8）：上一章只有 1 屏，加载期连按两次 PageDown 只能前进一章
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\n── 用例 1：M8 加载期连按「下一页」不得跨章 ──');
  layout.scrollWidth = widthForScreens(1); // 每章 1 屏：M8 的必要前提
  const chapters = [
    { index: 0, title: '第一章', href: 'ch1.xhtml' },
    { index: 1, title: '第二章', href: 'ch2.xhtml' },
    { index: 2, title: '第三章', href: 'ch3.xhtml' },
  ];
  // 第 1 章起延迟 300ms，模拟「换章后正文还没到」的加载期
  const { container, requested, cleanup } = await mountCase({
    chapters,
    delay: (index) => (index === 0 ? 0 : 300),
    html: chapterHtml,
  });

  const initial = parsePager(readPager(container));
  check('挂载后停在第 1 章（1 屏）', initial !== undefined && initial.chapter === 1 && initial.viewCount === 1, readPager(container));

  // 第 1 次：章末再翻 → 进入第 2 章（开始加载）；第 2 次：加载期再按一下
  pressKey('PageDown');
  await settle(3);
  check(
    '第一次 PageDown 已换到第 2 章并进入加载态',
    readChapterIndex(container) === 1 && readFlowText(container) === '',
    `chapterIndex=${readChapterIndex(container)}`,
  );
  pressKey('PageDown');
  await wait(420);
  await settle(6);

  check(
    '加载期第二次 PageDown 被丢弃：章序只前进 1（修复前会前进 2）',
    readChapterIndex(container) === 1,
    `chapterIndex=${readChapterIndex(container)}（期望 1）`,
  );
  check(
    '正文是第 2 章（没有被跳过）',
    readFlowText(container).includes('第2章正文'),
    readFlowText(container).slice(0, 40),
  );
  check(
    '没有发出第 3 章的请求（修复前 requested=[0,1,2]）',
    JSON.stringify(requested) === JSON.stringify([0, 1]),
    `requested=[${requested.join(',')}]`,
  );

  await cleanup();
}

// ═══════════════════════════════════════════════════════════════════════════
// 用例 2（反证 M9）：两次换章请求乱序返回，后到的旧响应不得覆盖新章
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\n── 用例 2：M9 旧换章响应不得覆盖新章正文 ──');
  layout.scrollWidth = widthForScreens(1);
  const chapters = [
    { index: 0, title: '第一章', href: 'ch1.xhtml' },
    { index: 1, title: '第二章', href: 'ch2.xhtml' },
    { index: 2, title: '第三章', href: 'ch3.xhtml' },
  ];
  // 先发的第 2 章慢（200ms），后发的第 3 章快（20ms）→ 返回顺序颠倒
  const { container, cleanup } = await mountCase({
    chapters,
    delay: (index) => (index === 1 ? 200 : index === 2 ? 20 : 0),
    html: chapterHtml,
  });

  check('挂载后停在第 1 章', readChapterIndex(container) === 0, `chapterIndex=${readChapterIndex(container)}`);

  selectChapter(container, 1);
  await settle(2);
  selectChapter(container, 2);
  await wait(320);
  await settle(6);

  check(
    '章号停在最后一次选择（第 3 章）',
    readChapterIndex(container) === 2,
    `chapterIndex=${readChapterIndex(container)}`,
  );
  check(
    '正文属于最后一次请求的章（第 3 章）',
    readFlowText(container).includes('第3章正文'),
    readFlowText(container).slice(0, 40),
  );
  check(
    '后到的旧响应（第 2 章）没有覆盖正文',
    !readFlowText(container).includes('第2章正文'),
    readFlowText(container).slice(0, 40),
  );

  await cleanup();
}

// ═══════════════════════════════════════════════════════════════════════════
// 用例 3：skip 章（纯标题页/分节页）不出现在目录、翻页与换章都被跳过
// ═══════════════════════════════════════════════════════════════════════════
{
  console.log('\n── 用例 3：skip 章的目录/翻页/换章行为 ──');
  layout.scrollWidth = widthForScreens(1);
  const chapters = [
    { index: 0, title: '第一章', href: 'ch1.xhtml' },
    { index: 1, title: '第二章', href: 'ch2.xhtml' },
    // 纯标题页：内容已并入下一章 → 目录不展示、翻页跳过
    { index: 2, title: '第二章 分节页', href: 'ch3.xhtml', skip: true },
    { index: 3, title: '第三章', href: 'ch4.xhtml' },
    { index: 4, title: '第四章', href: 'ch5.xhtml' },
  ];
  const html = (index) => (chapters[index].skip === true ? '<p>纯标题页</p>' : chapterHtml(index));
  const { container, requested, cleanup } = await mountCase({
    chapters,
    delay: () => 5,
    html,
  });

  const options = readOptions(container);
  check(
    '目录下拉只列非 skip 章（4 项，index 为 0/1/3/4）',
    JSON.stringify(options.map((option) => option.value)) === JSON.stringify(['0', '1', '3', '4']),
    `values=[${options.map((option) => option.value).join(',')}]`,
  );
  check(
    '目录下拉里没有 skip 章标题',
    options.every((option) => !option.text.includes('分节页')),
    options.map((option) => option.text.trim()).join(' | '),
  );
  check(
    '目录下拉的显示序号连续 1..N（不因跳过 skip 章而跳号）',
    options.every((option, position) => option.text.trim().startsWith(`${position + 1}. `)),
    options.map((option) => option.text.trim()).join(' | '),
  );

  const seen = [];
  const snapshots = [];
  for (let i = 0; i < 4; i += 1) {
    pressKey('PageDown');
    await wait(40);
    await settle(6);
    seen.push(readChapterIndex(container));
    snapshots.push(readFlowText(container));
  }

  check(
    '连翻跳过 skip 章：0 → 1 → 3 → 4（章序 2 从不落地）',
    JSON.stringify(seen) === JSON.stringify([1, 3, 4, 4]),
    `实际 [${seen.join(',')}]`,
  );
  check(
    '最后一章再翻不越界（停在章序 4）',
    readChapterIndex(container) === 4,
    `chapterIndex=${readChapterIndex(container)}`,
  );
  check(
    '正文渲染的是第 4 章（末章）',
    readFlowText(container).includes('第5章正文'),
    readFlowText(container).slice(0, 40),
  );
  check(
    'skip 章的正文从未被渲染',
    snapshots.every((text) => !text.includes('纯标题页')),
    snapshots.some((text) => text.includes('纯标题页')) ? '出现过「纯标题页」' : '未出现',
  );
  check(
    '翻页没有请求过 skip 章（requested 不含 2）',
    !requested.includes(2),
    `requested=[${requested.join(',')}]`,
  );
  const pagerAtEnd = parsePager(readPager(container));
  check(
    '页码章号用可见序号（末项显示 4/4，不是 5/5）',
    pagerAtEnd !== undefined && pagerAtEnd.chapter === 4 && pagerAtEnd.unitCount === 4,
    readPager(container),
  );

  // goChapter 落点纠偏：章内链接直接指向 skip 章 → 向后顺延到最近的非 skip 章
  clickChapterLink(container);
  await wait(40);
  await settle(6);
  check(
    '章内链接指向 skip 章时顺延到后面的正文（4 → 3，不是 2）',
    readChapterIndex(container) === 3,
    `chapterIndex=${readChapterIndex(container)}`,
  );
  check(
    '顺延后的正文是第 4 章',
    readFlowText(container).includes('第4章正文'),
    readFlowText(container).slice(0, 40),
  );

  // 从后往前翻同样要跨过 skip 章
  pressKey('PageUp');
  await wait(40);
  await settle(6);
  check(
    '上一页跨过 skip 章（3 → 1）',
    readChapterIndex(container) === 1,
    `chapterIndex=${readChapterIndex(container)}`,
  );
  check(
    '向前跨章落在第 2 章的正文（不是分节页）',
    readFlowText(container).includes('第2章正文'),
    readFlowText(container).slice(0, 40),
  );

  pressKey('PageUp');
  await wait(40);
  await settle(6);
  check('再上一页回到第 1 章', readChapterIndex(container) === 0, `chapterIndex=${readChapterIndex(container)}`);

  await cleanup();
}

window.close();
console.log(allPass ? '\n换章导航验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
