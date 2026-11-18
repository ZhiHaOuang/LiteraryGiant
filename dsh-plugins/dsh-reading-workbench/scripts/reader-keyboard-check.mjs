/**
 * 键盘翻页行为的组件级回归测试（真实 ReaderView + jsdom + 真实 keydown）。
 *
 * 背景：用户反馈「摁键盘下一页的时候，页面切换不准确」。根因之一是
 * **闭包里的 `view` 过期**：`setView(view + 1)` 在键盘连发时，每次 keydown 之间
 * React 尚未重渲染，几次都算出同一个值 → 只前进一屏（「按了没反应 / 跳得不准」）。
 *
 * 本脚本不模拟逻辑，而是挂载**真实的 ReaderView 组件**，用同步连发的
 * 真实 KeyboardEvent 驱动它，再读真实 DOM 里的页码文本断言结果。
 * 修复前（闭包计数）该用例会失败：按 5 次只前进 1 屏。
 *
 * 实现要点：jsdom 没有布局引擎，clientWidth/scrollWidth 恒为 0，
 * 所以对测量相关的属性打桩，让 FlowReader 能算出真实的多屏分页。
 *
 * 用法：node scripts/reader-keyboard-check.mjs
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
  if (stale.startsWith('rw-kbd-')) await rm(join(outParent, stale), { recursive: true, force: true });
}
const outRoot = await mkdtemp(join(outParent, 'rw-kbd-'));
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

// 视口与内容的尺寸桩：让 FlowReader 算出 viewCount > 1 的真实多屏分页
const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 600;
/** 目标列数与视口/列宽保持一致，便于反推需要的 scrollWidth。 */
const COLUMN_GAP = 48;
const PADDING = 32;
const available = VIEWPORT_WIDTH - PADDING * 2; // 936
const columnsPerView = available >= 380 * 2 + COLUMN_GAP ? 2 : 1; // auto → 2
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

// 让被测模块看到 jsdom 的全局环境
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
  title: '键盘翻页测试书',
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

/** 派发一次真实 keydown。 */
function pressKey(key) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
}

const initial = parsePager(readPager());
check('组件挂载后显示页码', initial !== undefined, readPager());
check(
  `排版出多屏（预期 ${expectedViewCount} 屏）`,
  initial?.viewCount === expectedViewCount,
  `实际 ${initial?.viewCount}`,
);
check('起始在第 1 屏', initial?.view === 1, `view=${initial?.view}`);

// ── 核心用例：同步连发 5 次（模拟键盘连发，期间不给 React 重渲染机会）──
const before = parsePager(readPager());
for (let i = 0; i < 5; i += 1) pressKey('ArrowRight');
await settle();
const after = parsePager(readPager());
check(
  '同步连发 5 次 ArrowRight：恰好前进 5 屏（闭包过期会只前进 1 屏）',
  after !== undefined && before !== undefined && after.view === before.view + 5,
  `${before?.view} → ${after?.view}（期望 ${(before?.view ?? 0) + 5}）`,
);

// ── 反向：连发 5 次左键回到起点 ──
for (let i = 0; i < 5; i += 1) pressKey('ArrowLeft');
await settle();
const back = parsePager(readPager());
check('同步连发 5 次 ArrowLeft：回到起点', back?.view === 1, `view=${back?.view}`);

// ── 空格与 PageDown 同为前进 ──
pressKey(' ');
pressKey('PageDown');
await settle();
const withSpace = parsePager(readPager());
check('空格与 PageDown 各前进一屏', withSpace?.view === 3, `view=${withSpace?.view}`);

// ── 末屏不越界 ──
for (let i = 0; i < 50; i += 1) pressKey('ArrowRight');
await settle();
const end = parsePager(readPager());
check(
  '连续 50 次前进：停在末屏且不越界',
  end !== undefined && end.view === end.viewCount,
  `view=${end?.view} viewCount=${end?.viewCount}`,
);

// ── Home/End ──
pressKey('Home');
await settle();
check('Home 回到第 1 屏', parsePager(readPager())?.view === 1, `view=${parsePager(readPager())?.view}`);
pressKey('End');
await settle();
check('End 到末屏', parsePager(readPager())?.view === parsePager(readPager())?.viewCount, readPager());

// ── 进度确实被保存（顺带验证 saveProgress 被调用）──
// 进度写入有 600ms 防抖，需要真等一段时间
await new Promise((resolve) => setTimeout(resolve, 750));
await settle(4);
check('翻页过程写入了进度', api.progressCalls.length > 0, `${api.progressCalls.length} 次`);

// 卸载组件（避免 jsdom 关闭后仍有人定时器）
root.unmount();
await settle(2);
window.close();

console.log(allPass ? '\n键盘翻页行为验证全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
