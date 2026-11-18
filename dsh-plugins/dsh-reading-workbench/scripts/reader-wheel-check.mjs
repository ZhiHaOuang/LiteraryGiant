/**
 * 滚轮翻页行为的组件级回归测试（真实 ReaderView + jsdom + 真实 WheelEvent）。
 *
 * 覆盖点：
 * 1. 向下滚 → 下一页；向上滚 → 上一页；
 * 2. **阈值**：触控板那种极小 deltaY 的高频事件不该翻页；
 * 3. **冷却**：一次大 delta 之后 260ms 内连发只认第一次（不跳多页）；
 * 4. 换方向立刻生效（不被上方向的累积粘住）；
 * 5. 有文字选区时不翻页（用户正在选字）；
 * 6. 末屏/首屏不越界；
 * 7. 监听是 **非 passive** 的（否则 preventDefault 无效、外层跟着滚）。
 *
 * 为什么不用 React 的 onWheel：浏览器对 wheel 默认用 passive 监听，
 * 在 React 合成事件里调 preventDefault() 会被忽略并告警。所以实现里是
 * 手动 addEventListener(..., { passive: false })，本测试直接对该 DOM 节点
 * 派发真实事件，走的是同一路径。
 *
 * 用法：node scripts/reader-wheel-check.mjs
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

// ── 0) 钉住唯一的 react 实例 ──
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
  if (stale.startsWith('rw-wheel-')) await rm(join(outParent, stale), { recursive: true, force: true });
}
const outRoot = await mkdtemp(join(outParent, 'rw-wheel-'));
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
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 600;
const COLUMN_GAP = 48;
const PADDING = 32;
const available = VIEWPORT_WIDTH - PADDING * 2;
const columnsPerView = available >= 380 * 2 + COLUMN_GAP ? 2 : 1;
const columnWidth = columnsPerView === 2 ? (available - COLUMN_GAP) / 2 : available;
const WANTED_COLUMNS = 12;
const stubbedScrollWidth = WANTED_COLUMNS * columnWidth + (WANTED_COLUMNS - 1) * COLUMN_GAP;
const expectedViewCount = Math.ceil(WANTED_COLUMNS / columnsPerView);

/** 给元素打桩 clientWidth/clientHeight/scrollWidth。 */
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
      return this.classList?.contains('dsh-reading-flow') ? stubbedScrollWidth : 0;
    },
  });
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

/** 假 API：返回足够长的正文以产生多屏。 */
function fakeApi() {
  const progressCalls = [];
  return {
    progressCalls,
    toc: async () => ({ book: {}, chapters: [{ index: 0, title: '第一章', href: 'ch1.xhtml' }] }),
    chapter: async () => ({ book: {}, chapter: {}, html: '<p>正文</p>', chapterCount: 1 }),
    content: async () => ({ book: {}, content: '# 标题\n\n' + '正文段落。'.repeat(200) }),
    assetUrl: (id, path) => `asset?${id}&${path}`,
    fileUrl: (id) => `file?${id}`,
    saveProgress: async (request) => {
      progressCalls.push(request);
      return { saved: true };
    },
  };
}

const book = {
  id: 'b1',
  title: '滚轮翻页测试书',
  author: '测试',
  sourcePath: 'upload:x.md',
  format: 'md',
  addedAt: 1,
  hasCover: false,
};

const api = fakeApi();
const container = window.document.getElementById('root');
const root = createRoot(container);

/** 等若干轮事件循环，让异步 effect 收敛。 */
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

root.render(
  createElement(ReaderView, {
    api,
    t,
    book,
    settings: { fontSize: 17, lineHeight: 1.9, theme: 'follow', columns: 'auto' },
    progress: undefined,
    onSettingsChange: () => {},
    onBack: () => {},
  }),
);
await settle();

/** 读当前页码文本（形如 "3/6 页"）。 */
function readPager() {
  const element = container.querySelector('.dsh-reading-pager');
  return element === null ? '' : element.textContent ?? '';
}

/** 从页码文本解析出当前屏号（1 起）与总屏数。 */
function parsePager(text) {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (match === null) return undefined;
  return { view: Number(match[1]), viewCount: Number(match[2]) };
}

/** 当前屏号。 */
const currentView = () => parsePager(readPager())?.view;

/** 滚轮目标：未平移的视口元素（监听就挂在它上面）。 */
function viewport() {
  const element = container.querySelector('.dsh-reading-viewport');
  if (element === null) throw new Error('找不到 .dsh-reading-viewport');
  return element;
}

/** 派发一次真实 wheel 事件；返回事件对象以便检查 defaultPrevented。 */
function wheel(deltaY, options = {}) {
  const event = new window.WheelEvent('wheel', {
    deltaY,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  viewport().dispatchEvent(event);
  return event;
}

/**
 * 推进真实时间越过冷却窗口。
 * 冷却用 Date.now()，这里直接等真实时间，避免打桩与实现耦合。
 */
const coolDown = () => new Promise((resolve) => setTimeout(resolve, 290));

const initial = parsePager(readPager());
check('组件挂载后显示页码', initial !== undefined, readPager());
check(`排版出多屏（预期 ${expectedViewCount} 屏）`, initial?.viewCount === expectedViewCount, `实际 ${initial?.viewCount}`);

// ── 用例 1：监听是非 passive 的（preventDefault 必须真的生效）──
const prevented = wheel(120);
await settle();
check('wheel 事件被 preventDefault（外层页面不会跟着滚）', prevented.defaultPrevented === true);
check('向下滚一页 → 前进一屏', currentView() === 2, `view=${currentView()}`);

// ── 用例 2：冷却期内连发只翻 1 页（不跳多页，也不排队补翻）──
// 先越过上一用例的冷却，否则"连发 3 次"里的第一次会被冷却挡掉，测不到本来要测的东西。
await coolDown();
const beforeBurst = currentView();
wheel(120);
wheel(120);
wheel(120);
await settle();
const afterBurst = currentView();
check(
  '冷却期内连发 3 次只前进 1 屏（不会一滑跳三页）',
  afterBurst === beforeBurst + 1,
  `${beforeBurst} → ${afterBurst}`,
);
// 冷却期内的事件应被丢弃：冷却过去后不应有"补翻"余波
await coolDown();
await settle();
check(
  '冷却期内的残余事件被丢弃，不会延后补翻',
  currentView() === afterBurst,
  `${afterBurst} → ${currentView()}`,
);

// ── 用例 3：向上滚回退 ──
await coolDown();
const beforeUp = currentView();
wheel(-120);
await settle();
check('向上滚 → 后退一屏', currentView() === beforeUp - 1, `${beforeUp} → ${currentView()}`);

// ── 用例 4：阈值——触控板式极小 deltaY 不翻页 ──
await coolDown();
const beforeSmall = currentView();
for (let i = 0; i < 5; i += 1) {
  wheel(8);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
await settle();
check(
  '连续 5 次极小 deltaY（8×5=40 < 阈值 100）不翻页',
  currentView() === beforeSmall,
  `${beforeSmall} → ${currentView()}`,
);

// ── 用例 5：累积够阈值就翻页（触控板慢慢滚也能翻）──
await coolDown();
const beforeAccum = currentView();
for (let i = 0; i < 4; i += 1) {
  wheel(30);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
await settle();
check(
  '累积 deltaY（30×4=120 ≥ 阈值）翻一页',
  currentView() === beforeAccum + 1,
  `${beforeAccum} → ${currentView()}`,
);

// ── 用例 6：换方向立即生效，不被上方向累积粘住 ──
await coolDown();
const beforeFlip = currentView();
wheel(90); // 不足阈值，留下 +90 的累积
await new Promise((resolve) => setTimeout(resolve, 5));
wheel(-90); // 反向：累积清零后不足阈值，不该翻
await settle();
check('反向小幅滚动不误翻（方向切换会清零累积）', currentView() === beforeFlip, `${beforeFlip} → ${currentView()}`);

// ── 用例 7：有文字选区时不翻页 ──
await coolDown();
const beforeSelection = currentView();
const paragraph = container.querySelector('.dsh-reading-flow p') ?? viewport();
const range = window.document.createRange();
range.selectNodeContents(paragraph);
const selection = window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
wheel(120);
await settle();
check('存在文字选区时滚轮不翻页', currentView() === beforeSelection, `${beforeSelection} → ${currentView()}`);
selection.removeAllRanges();

// ── 用例 8：首屏向上滚不越界 ──
// 每次滚动之间都要越过冷却，否则第二格会被丢弃（那是用例 2 已覆盖的行为）。
// 一直退到第 1 屏，再多退几格确认不越界。
let backGuard = 0;
while (backGuard < 20 && currentView() !== 1) {
  await coolDown();
  wheel(-120);
  await settle(3);
  backGuard += 1;
}
check('滚轮可退回首屏', currentView() === 1, `view=${currentView()}`);
for (let i = 0; i < 3; i += 1) {
  await coolDown();
  wheel(-120);
  await settle(3);
}
check('第 1 屏继续向上滚不越界', currentView() === 1, `view=${currentView()}`);

// ── 用例 9：末屏向下滚不越界 ──
let guard = 0;
while (guard < 40 && currentView() !== expectedViewCount) {
  await coolDown();
  wheel(120);
  await settle(3);
  guard += 1;
}
check('滚轮可到末屏', currentView() === expectedViewCount, `view=${currentView()}`);
await coolDown();
wheel(120);
await settle();
check('末屏向下滚不越界', currentView() === expectedViewCount, `view=${currentView()}`);

root.unmount();
await settle(2);
window.close();

console.log(allPass ? '\n滚轮翻页行为验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
