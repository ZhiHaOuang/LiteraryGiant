/**
 * 划线端到端复现：挂载真实 ReaderView，模拟「选区 → 点划线按钮 → 掉 api.createHighlight」。
 *
 * ## 为什么需要这个脚本
 *
 * 用户反馈「操作了划线之后，数据没有保存上」，而 Host 侧 `POST /highlights` 实测返回 200、
 * 数据也落盘 —— 说明问题在前端链路里。`createMark` 有三处**静默 return**：
 *
 * ```js
 * if (root === null || !hasMeaningfulSelection(selection)) return;
 * const hit = selectionOffsetInFlow(root, selection);
 * if (hit === undefined) return;
 * if (text === '') return;
 * ```
 *
 * 任何一处判定失败，用户看到的就是「点了没反应、也没报错、数据没保存」。
 * 之前的套件只测 mark-anchor 纯函数与 jsdom 高亮，**没有一条覆盖这个按钮的真实点击链路**。
 *
 * 用法：node scripts/mark-create-check.mjs
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

// 唯一 react 实例（与其它组件级检查一致）
const reactDomEntry = require.resolve('react-dom/server');
const sharedRequire = createRequire(reactDomEntry);
const reactEntry = sharedRequire.resolve('react');
const reactJsxEntry = sharedRequire.resolve('react/jsx-runtime');
const reactDomClientEntry = require.resolve('react-dom/client');

/** 固定 react 到唯一实例。 */
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

const outParent = join(pluginRoot, 'node_modules', '.cache');
await mkdir(outParent, { recursive: true });
for (const stale of await readdir(outParent).catch(() => [])) {
  if (stale.startsWith('rw-markcreate-')) await rm(join(outParent, stale), { recursive: true, force: true });
}
const outRoot = await mkdtemp(join(outParent, 'rw-markcreate-'));
process.on('exit', () => {
  try {
    rmSync(outRoot, { recursive: true, force: true });
  } catch {
    /* 退出阶段清理失败无需上报 */
  }
});

const outPathOf = (sourceFile) => join(outRoot, relative(srcRoot, sourceFile).replace(/\.tsx?$/, '.js'));

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
        const target = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`].find((c) => existsSync(c));
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

// ── jsdom 环境 ──
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 600;
const COLUMN_GAP = 48;
const PADDING = 32;
const available = VIEWPORT_WIDTH - PADDING * 2;
const columnsPerView = available >= 380 * 2 + COLUMN_GAP ? 2 : 1;
const columnWidth = columnsPerView === 2 ? (available - COLUMN_GAP) / 2 : available;
const WANTED_COLUMNS = 6;
const stubbedScrollWidth = WANTED_COLUMNS * columnWidth + (WANTED_COLUMNS - 1) * COLUMN_GAP;

Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-viewport') ? VIEWPORT_WIDTH : 0;
    },
  },
  clientHeight: {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-viewport') ? VIEWPORT_HEIGHT : 0;
    },
  },
  scrollWidth: {
    configurable: true,
    get() {
      return this.classList?.contains('dsh-reading-flow') ? stubbedScrollWidth : 0;
    },
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

/*
 * jsdom 没有实现 Range.getBoundingClientRect / getClientRects（真实浏览器有），
 * 而 `onReaderMouseUp` 要用它给浮动按钮定位。不打桩的话整个 mouseup 处理会抛错，
 * 测出来的是「jsdom 缺 API」而不是产品问题 —— 上一版就卡在这里。
 */
const FAKE_SELECTION_BOX = { left: 120, top: 200, right: 420, bottom: 224, width: 300, height: 24 };
const FAKE_CLIENT_RECT = { left: 120, top: 200, right: 420, bottom: 224, width: 300, height: 24 };
window.Range.prototype.getBoundingClientRect = function () {
  return { ...FAKE_SELECTION_BOX };
};
window.Range.prototype.getClientRects = function () {
  const list = [FAKE_CLIENT_RECT];
  // getClientRects 的返回值只需要可迭代 + 有 length（代码里用 Array.from）
  list.item = (i) => list[i];
  return list;
};

/*
 * 模拟真实浏览器「点击按钮会清空选区」的行为。
 *
 * 这是本 bug 的核心：真实浏览器在按钮 mousedown 时就会丢掉 selection，
 * 若按钮没在 mousedown 上 preventDefault，click 时 getSelection() 已为空。
 * jsdom 不会自动这么做，所以这里**显式建模**：给按钮的 mousedown 派发后，
 * 若事件没有被 preventDefault，就清掉选区 —— 与 Chromium 行为一致。
 */
function dispatchClickLikeBrowser(button) {
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button.dispatchEvent(down);
  if (!down.defaultPrevented) {
    // 没被阻止 → 浏览器会清空选区（这正是根因）
    window.getSelection()?.removeAllRanges();
  }
  button.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ResizeObserver = window.ResizeObserver;
// collectFlowText 用 document.createTreeWalker(root, NodeFilter.SHOW_TEXT)；
// NodeFilter / Element 在 Node 里没有，必须从 jsdom 暴露（缺了会抛在 createMark 里，
// 表现得和「划线失败」一模一样 —— 上一版就因此多绕了一圈）。
globalThis.NodeFilter = window.NodeFilter;
globalThis.Element = window.Element;
globalThis.HTMLDivElement = window.HTMLDivElement;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
if (globalThis.performance === undefined) globalThis.performance = window.performance;

const { createElement } = await import(pathToFileURL(reactEntry).href);
const { createRoot } = await import(pathToFileURL(reactDomClientEntry).href);
const reactDom = await import(pathToFileURL(sharedRequire.resolve('react-dom')).href);
const flushSync = reactDom.flushSync ?? ((fn) => fn());
const { ReaderView } = await import(pathToFileURL(join(outRoot, 'client/panel/ReaderView.js')).href);
const { zh } = await import(pathToFileURL(join(outRoot, 'client/locales.js')).href);
const t = (key) => zh[key] ?? key;

/** 假 API：记录划线创建调用。 */
function fakeApi() {
  const created = [];
  return {
    created,
    toc: async () => ({ book: {}, chapters: [{ index: 0, title: '第一章', href: 'ch1.xhtml' }] }),
    chapter: async () => ({ book: {}, chapter: {}, html: '<p>正文</p>', chapterCount: 1 }),
    content: async () => ({
      book: {},
      content: '# 标题\n\n' + '这是用于验证划线保存链路的正文段落，需要足够长以便排版成多屏。'.repeat(30),
    }),
    assetUrl: (id, path) => `asset?${id}&${path}`,
    fileUrl: (id) => `file?${id}`,
    bookStyles: async () => ({ css: '', files: [], warnings: [] }),
    saveProgress: async () => ({ saved: true }),
    listHighlights: async () => [],
    createHighlight: async (requestBody) => {
      created.push(requestBody);
      return { id: 'mark-1', ...requestBody, createdAt: 1 };
    },
    updateHighlightNote: async (id, note) => ({ id, note, createdAt: 1 }),
    deleteHighlight: async () => ({ removed: true }),
  };
}

const book = {
  id: 'b1',
  title: '划线链路测试书',
  author: '测试',
  sourcePath: 'upload:x.md',
  format: 'md',
  addedAt: 1,
  hasCover: false,
};

const api = fakeApi();
const root = createRoot(window.document.getElementById('root'));

const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  }
}

flushSync(() => {
  root.render(
    createElement(ReaderView, {
      api,
      t,
      book,
      settings: { fontSize: 17, lineHeight: 1.9, theme: 'follow', columns: 'auto', txtReflow: 'auto', bookCss: 'book', fontFamily: 'system' },
      progress: undefined,
      onSettingsChange: () => {},
      onBack: () => {},
    }),
  );
});
await settle();

// ── 1) 找到 flow 容器并确认正文已渲染 ──
const flow = window.document.querySelector('.dsh-reading-flow');
check('正文 flow 容器已渲染', flow !== null);
check('正文有文本内容', (flow?.textContent ?? '').length > 50, `${(flow?.textContent ?? '').length} 字符`);

// ── 2) 构造真实选区（选中 flow 里第一个文本节点的一段）──
/** 在 flow 里选中第 index 个文本节点的一截。 */
function selectTextNode(node, start, end) {
  const range = window.document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

/** 收集 flow 里的文本节点。 */
function textNodesIn(element) {
  const walker = window.document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
  const nodes = [];
  let current = walker.nextNode();
  while (current !== null) {
    if ((current.textContent ?? '').trim() !== '') nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

const textNodes = textNodesIn(flow);
check('flow 里有可选择的文本节点', textNodes.length > 0, `${textNodes.length} 个`);

const target = textNodes[0];
const selection = selectTextNode(target, 0, Math.min(12, (target.textContent ?? '').length));
check('选区已建立', window.getSelection()?.toString().length > 0, JSON.stringify(window.getSelection()?.toString()));

// ── 3) 派发 mouseup（ReaderView 用它决定是否显示「划线」浮动按钮）──
const viewportEl = window.document.querySelector('.dsh-reading-viewport') ?? flow;
const mouseUp = new window.MouseEvent('mouseup', { bubbles: true, cancelable: true });
flushSync(() => {
  viewportEl.dispatchEvent(mouseUp);
});
await settle(4);

const popupButton = window.document.querySelector('.dsh-reading-markpopup-btn');
check('选区后出现「划线」浮动按钮', popupButton !== null, popupButton === null ? '按钮未出现（onReaderMouseUp 未通过判定）' : '');
check('按钮文案正确', (popupButton?.textContent ?? '').includes(zh['mark.button']), popupButton?.textContent);

// ── 4) 点击按钮（按真实浏览器序列：mousedown 可能清空选区）──
if (popupButton !== null) {
  // 关键断言：按钮必须在 mousedown 上 preventDefault，否则选区会被清掉。
  const probeDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  popupButton.dispatchEvent(probeDown);
  check(
    '⭐ 按钮在 mousedown 上 preventDefault（否则选区被清空、划线永远存不上）',
    probeDown.defaultPrevented === true,
    probeDown.defaultPrevented ? '' : '未阻止 → 浏览器会先清空选区',
  );

  // 选区在 mousedown 之后仍然存在（preventDefault 生效的直接后果）
  const selectionAfterDown = window.getSelection()?.toString() ?? '';
  check('mousedown 之后选区仍在', selectionAfterDown.length > 0, JSON.stringify(selectionAfterDown));

  if (selectionAfterDown.length === 0) {
    // 选区没了就重建一次，继续验证后续链路（否则只能测到失败）
    selectTextNode(target, 0, Math.min(12, (target.textContent ?? '').length));
  }

  flushSync(() => {
    dispatchClickLikeBrowser(popupButton);
  });
  await settle(8);
}

check('⭐ 点击后调用了 api.createHighlight（数据能保存）', api.created.length === 1, `调用次数=${api.created.length}`);
if (api.created.length > 0) {
  const request = api.created[0];
  check('提交了 bookId', request?.bookId === 'b1', String(request?.bookId));
  check('提交了非空 text', typeof request?.text === 'string' && request.text !== '', JSON.stringify(request?.text));
  check('提交了 mark 锚点', typeof request?.anchor === 'string' && request.anchor.startsWith('mark:'), String(request?.anchor));
  const parsed = /mark:off=(\d+):len=(\d+)/.exec(request?.anchor ?? '');
  check('锚点里 offset/len 是有效数字', parsed !== null, String(request?.anchor));
  if (parsed !== null) {
    check('锚点长度 > 0', Number(parsed[2]) > 0, `len=${parsed[2]}`);
  }
}

// ── 5) 若失败，用「失败提示文案」反查走了哪条 return ──
if (api.created.length === 0) {
  console.log('\n--- 诊断（用 mark.failed.* 提示反查走了哪条 return）---');
  const bodyText = window.document.body.textContent ?? '';
  const reasons = [
    ['notReady', zh['mark.failed.notReady']],
    ['selectionLost', zh['mark.failed.selectionLost']],
    ['outOfFlow', zh['mark.failed.outOfFlow']],
    ['empty', zh['mark.failed.empty']],
  ];
  let hitReason;
  for (const [key, text] of reasons) {
    if (text !== undefined && bodyText.includes(text)) {
      hitReason = key;
      console.log(`  命中失败路径: ${key} → "${text}"`);
    }
  }
  if (hitReason === undefined) {
    console.log('  未出现任何 mark.failed.* 提示 → createMark 可能没被调用，或走到了别处');
  }
  const liveSelection = window.getSelection();
  console.log(`  window.getSelection() 非空: ${liveSelection !== null && liveSelection.rangeCount > 0}`);
  console.log(`  选区文本: ${JSON.stringify(liveSelection?.toString() ?? '')}`);
}

console.log(`\n${fail === 0 ? '划线创建链路全部通过' : '存在失败项'}：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
