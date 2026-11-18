/**
 * FlowReader 测量链路回归：**图片加载完成后的重测必须生效**。
 *
 * 缺陷背景（2026-10-30 用户实测）：
 * 用户在《情绪流龙头战法》「第十三节 龙头股的演进过程」只看到 1 页（进度记录 pct=100）。
 * 该章有 1059 字 + **11 张插图**，图片加载完成后应是 7 列 ≈ 4 屏。
 *
 * 根因：`FlowReader` 里用 `ref={externalFlowRef}` + 一个「把内部 ref 同步到外部」的
 * `useEffect`；内部 ref 从未绑定 DOM（永远 null），于是每个 passive effect 都把外部
 * ref 覆盖成 null → `measureFlow()` 从第二帧起 early return → 图片加载完成 / 窗口缩放 /
 * 字号变化后的重测全部失效 → 分页永远停在「首测时图片还没加载」的 1 屏。
 *
 * 本脚本挂载**真实 FlowReader 组件**（jsdom + 布局打桩），断言：
 *  1. 挂载后外部 ref 必须指向 flow DOM（旧实现为 null）；
 *  2. 首测只有 1 屏（模拟图片未加载的容器宽度）；
 *  3. 把 scrollWidth 改大 + 向 flow 派发 load 事件（模拟图片加载完成）后，
 *     分页必须更新到 4 屏（旧实现不会更新）；
 *  4. 字号变化重渲染后外部 ref 仍非 null（旧实现会被置 null）；
 *  5. 反证：手动把 ref 置 null 后派发 load，分页**不更新** —— 证明本用例确实有鉴别力。
 *
 * 用法：node scripts/flow-ref-measure-check.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const srcRoot = join(pluginRoot, 'src');
const require = createRequire(import.meta.url);

// ── 0) 锁住唯一 react 实例 ──
const reactDomEntry = require.resolve('react-dom/server');
const reactDomClientEntry = require.resolve('react-dom/client');
const sharedRequire = createRequire(reactDomEntry);
const reactEntry = sharedRequire.resolve('react');
const reactJsxEntry = sharedRequire.resolve('react/jsx-runtime');

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
  if (stale.startsWith('rw-flowref-')) await rm(join(outParent, stale), { recursive: true, force: true });
}
const outRoot = await mkdtemp(join(outParent, 'rw-flowref-'));
process.on('exit', () => {
  try {
    rmSync(outRoot, { recursive: true, force: true });
  } catch {
    /* 退出阶段清理失败无需上报 */
  }
});

function outPathOf(sourceFile) {
  return join(outRoot, relative(srcRoot, sourceFile).replace(/\.tsx?$/, '.js'));
}

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

await transpileGraph([join(srcRoot, 'client/panel/FlowReader.tsx')]);
await writeFile(join(outRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

// ── 2) jsdom + 布局打桩 ──
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 600;
const COLUMN_GAP = 48;
const PADDING = 32;
const available = VIEWPORT_WIDTH - PADDING * 2;
const columnsPerView = available >= 380 * 2 + COLUMN_GAP ? 2 : 1;
const columnWidth = columnsPerView === 2 ? (available - COLUMN_GAP) / 2 : available;
/** 图片未加载时：内容只有文字，滚动宽 = 容器宽（2 列）→ 1 屏。 */
const scrollWidthWithoutImages = columnWidth * columnsPerView + COLUMN_GAP * (columnsPerView - 1);
/** 图片加载完成后：7 列 → 4 屏。 */
const WANTED_COLUMNS = 7;
const scrollWidthWithImages = WANTED_COLUMNS * columnWidth + (WANTED_COLUMNS - 1) * COLUMN_GAP;
const expectedViewCount = Math.ceil(WANTED_COLUMNS / columnsPerView);
let currentScrollWidth = scrollWidthWithoutImages;

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
      return this.classList?.contains('dsh-reading-flow') ? currentScrollWidth : 0;
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

// ── 3) 挂载真实 FlowReader ──
const { createElement, createRef } = await import(pathToFileURL(reactEntry).href);
const { createRoot } = await import(pathToFileURL(reactDomClientEntry).href);
const { FlowReader } = await import(pathToFileURL(join(outRoot, 'client/panel/FlowReader.js')).href);

const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const container = window.document.getElementById('root');
const root = createRoot(container);
const flowRef = createRef();
/** 每次分页上报都记下来，用于判断「有没有发生第二次测量」。 */
const reported = [];

function renderReader(fontSize) {
  root.render(
    createElement(FlowReader, {
      html: '<p>正文段落。'.repeat(1) + '</p>',
      plain: false,
      book: false,
      fontSize,
      lineHeight: 1.9,
      columns: 'auto',
      view: 0,
      onPagination: (pagination) => {
        reported.push({ viewCount: pagination.viewCount, columnCount: pagination.columnCount });
      },
      flowRef,
      contentKey: 'flow-ref-check',
    }),
  );
}

renderReader(17);
await settle();

const flowElement = container.querySelector('.dsh-reading-flow');
check('FlowReader 渲染出 .dsh-reading-flow', flowElement !== null);
check(
  '外部 flow ref 必须指向 flow DOM（旧实现被 useEffect 置成 null）',
  flowRef.current !== null && flowRef.current === flowElement,
  `ref=${flowRef.current === null ? 'null' : flowRef.current.className}`,
);
check(
  '首测屏数 = 1（模拟图片未加载，内容只占一屏）',
  reported.at(-1)?.viewCount === 1,
  `上报 ${JSON.stringify(reported.at(-1))}`,
);

// ── 核心用例：图片加载完成 → 重新测量 ──
const reportsBeforeLoad = reported.length;
currentScrollWidth = scrollWidthWithImages;
flowElement.dispatchEvent(new window.Event('load')); // 模拟 img 的 load（捕获阶段由 flow 收到）
await settle(20);
check(
  `图片加载完成后重测为 ${expectedViewCount} 屏（旧实现停在 1 屏）`,
  reported.at(-1)?.viewCount === expectedViewCount,
  `上报次数 ${reportsBeforeLoad} → ${reported.length}，最新 ${JSON.stringify(reported.at(-1))}`,
);

// ── 窗口/字号变化后仍需能重测 ──
currentScrollWidth = scrollWidthWithImages + 632 * 4; // 再宽 4 列
renderReader(19);
await settle(20);
check(
  '字号变化重渲染后外部 ref 仍有效（旧实现被置 null，测量从此失效）',
  flowRef.current !== null && flowRef.current === container.querySelector('.dsh-reading-flow'),
);
check(
  '字号变化后的重测仍然生效',
  (reported.at(-1)?.columnCount ?? 0) > WANTED_COLUMNS,
  `最新 ${JSON.stringify(reported.at(-1))}`,
);

// ── 反证/防回潮：源码里不得再出现「把外部 ref 覆盖成内部 ref」的旧写法 ──
// 运行时无法从外部破坏组件内部的 ref，因此这里用源码反向断言（仓库既有防回潮手法）：
// 旧实现的标志是 `externalFlowRef.current = internalFlowRef.current` + `ref={externalRef}`，
// 两者任一回归都会让这段断言失败。
const flowReaderSource = await readFile(join(srcRoot, 'client/panel/FlowReader.tsx'), 'utf8');
check(
  '反证：不得再出现「外部 ref ← 内部 ref」的覆盖写法',
  !/externalFlowRef\.current\s*=\s*internalFlowRef\.current/.test(flowReaderSource),
);
check(
  '反证：flow 的 ref 必须是同时写内外 ref 的回调',
  /ref=\{attachFlow\}/.test(flowReaderSource) && /internalFlowRef\.current\s*=\s*element/.test(flowReaderSource),
);

console.log(allPass ? '\nFlowReader 测量链路回归通过' : '\nFlowReader 测量链路回归失败');
root.unmount();
process.exit(allPass ? 0 : 1);
