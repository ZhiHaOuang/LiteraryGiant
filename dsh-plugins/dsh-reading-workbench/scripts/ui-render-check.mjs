/**
 * UI 渲染冒烟测试（jsdom + react-dom/server）。
 *
 * 为什么要有这一层：这次 UI v2 是一次大改（书架网格 / 卡片 / 分页阅读器全部重写），
 * 而浏览器里的报错我无法直接观察。把组件真渲染一遍，能抓住
 * 「JSX 写错、条件分支漏判、访问 undefined 属性」这类会让面板白屏的崩溃。
 *
 * 实现：Node 24 能直接跑 `.ts`（类型擦除），但**不认 TSX 语法**，
 * 因此先用 TypeScript 编译器 API 把被测组件的依赖图转译到临时目录
 * （jsx: react-jsx，相对 import 的 `.ts/.tsx` 改写为 `.js`），再从中导入。
 *
 * 覆盖：书架空态 / 书架有书 / 封面回落 / 阅读态（EPUB 与 TXT 等）。
 * 用法：node scripts/ui-render-check.mjs
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

// ── 0) 先钉住唯一的 react 实例 ───────────────────────────
// react / react-dom 必须共享**同一份** react，否则报
// "more than one copy of React"（hooks 直接失效）。
// 插件 node_modules 下的 react-dom 是指向 profile 依赖的 junction，它解析到的 react
// 与插件自己的 react 不是同一份；因此统一以 react-dom 解析出的 react 为唯一实例，
// 并在转译时把裸 `react` 导入改写成它的绝对路径。
const reactDomEntry = require.resolve('react-dom/server');
const sharedRequire = createRequire(reactDomEntry);
const reactEntry = sharedRequire.resolve('react');
const reactJsxEntry = sharedRequire.resolve('react/jsx-runtime');

/** 把裸 react 导入改写成唯一实例的绝对路径（文件 URL 形式）。 */
function pinReactSpecifiers(code) {
  return code.replace(
    /(from\s+|import\s*\(\s*)(['"])(react(?:\/jsx-runtime)?)\2/g,
    (match, prefix, quote, spec) =>
      `${prefix}${quote}${pathToFileURL(spec === 'react' ? reactEntry : reactJsxEntry).href}${quote}`,
  );
}

// ── 1) 转译依赖图到临时目录 ─────────────────────────────
const outParent = join(pluginRoot, 'node_modules', '.cache');
await mkdir(outParent, { recursive: true });
// 先清掉此前异常中断留下的产物（本脚本只在成功路径上删自己那份）
for (const stale of await readdir(outParent).catch(() => [])) {
  if (stale.startsWith('rw-ui-check-')) {
    await rm(join(outParent, stale), { recursive: true, force: true });
  }
}
const outRoot = await mkdtemp(join(outParent, 'rw-ui-check-'));
// 无论断言成败还是中途抛错，都要清掉转译产物
process.on('exit', () => {
  try {
    rmSync(outRoot, { recursive: true, force: true });
  } catch {
    // 退出阶段的清理失败无需上报
  }
});

/** 源文件 → 转译产物的输出路径（保持 src 下的相对结构）。 */
function outPathOf(sourceFile) {
  return join(outRoot, relative(srcRoot, sourceFile).replace(/\.tsx?$/, '.js'));
}

/** 把入口的依赖图递归转译（只处理 src 内的相对导入）。 */
async function transpileGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = await readFile(file, 'utf8');
    const output = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        verbatimModuleSyntax: false,
      },
      fileName: file,
    }).outputText;
    // 相对导入的 .ts/.tsx → 对应的 .js 产物，并按**本文件的产物目录**算相对路径
    const outPath = outPathOf(file);
    const rewritten = pinReactSpecifiers(
      output.replace(
        /(from\s+|import\s*\(\s*)(['"])(\.[^'"]+)\2/g,
        (match, prefix, quote, spec) => {
          const resolved = resolve(dirname(file), spec);
          const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`];
          const target = candidates.find((candidate) => existsSync(candidate));
          if (target === undefined) return match;
          if (target.endsWith('.ts') || target.endsWith('.tsx')) queue.push(target);
          const rel = relative(dirname(outPath), outPathOf(target)).split(sep).join('/');
          return `${prefix}${quote}${rel.startsWith('.') ? rel : `./${rel}`}${quote}`;
        },
      ),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, rewritten, 'utf8');
  }
}

await transpileGraph([
  join(srcRoot, 'client/panel/ShelfView.tsx'),
  join(srcRoot, 'client/panel/ReaderView.tsx'),
  join(srcRoot, 'client/locales.ts'),
]);
// 临时目录声明 ESM（Node 按最近的 package.json 判定模块类型）
await writeFile(join(outRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

// ── 2) 先建全局 DOM（DOMPurify 需要），再导入被测模块 ──
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
// Node 24 的 navigator 是只读 getter，用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
// 组件挂载阶段会用到；renderToStaticMarkup 不执行 effect，但取值时不应炸
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.fetch = async () => new Response('{}', { status: 200 });

const { createElement } = await import(pathToFileURL(reactEntry).href);
const { renderToStaticMarkup } = await import(pathToFileURL(reactDomEntry).href);
const { ShelfView } = await import(pathToFileURL(join(outRoot, 'client/panel/ShelfView.js')).href);
const { ReaderView } = await import(pathToFileURL(join(outRoot, 'client/panel/ReaderView.js')).href);
const { zh } = await import(pathToFileURL(join(outRoot, 'client/locales.js')).href);

/** 测试用 t：直接查 zh 词典。 */
const t = (key) => zh[key] ?? key;

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 渲染并捕获异常（渲染崩溃就是白屏，必须显式失败）。 */
function render(label, element) {
  try {
    return { html: renderToStaticMarkup(element), error: undefined };
  } catch (error) {
    return { html: '', error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 假 API（只记录调用，不发请求）。 */
function fakeApi() {
  const calls = [];
  return {
    calls,
    listBooks: async () => [],
    settings: async () => ({ reader: { fontSize: 17, lineHeight: 1.9, theme: 'follow', columns: 'auto' } }),
    saveSettings: async () => ({}),
    saveReaderSettings: async () => ({}),
    saveProgress: async () => ({ saved: true }),
    coverUrl: (id) => `api/reading-workbench/cover?id=${id}`,
    assetUrl: (id, path) => `api/reading-workbench/asset?bookId=${id}&path=${encodeURIComponent(path)}`,
    fileUrl: (id) => `api/reading-workbench/file?id=${id}`,
    toc: async () => ({ book: {}, chapters: [] }),
    chapter: async () => ({ book: {}, chapter: {}, html: '', chapterCount: 0 }),
    content: async () => ({ book: {}, content: '' }),
    listHighlights: async () => [],
    removeBook: async () => ({ removed: true }),
  };
}

/** 造一本书目条目。 */
function makeEntry(overrides = {}) {
  return {
    book: {
      id: 'book-1',
      title: overrides.title ?? '测试书籍',
      author: overrides.author ?? '测试作者',
      sourcePath: 'upload:x.epub',
      format: overrides.format ?? 'epub',
      addedAt: 1,
      hasCover: overrides.hasCover,
    },
    progress: overrides.progress,
    highlightCount: overrides.highlightCount ?? 0,
  };
}

const noop = () => {};

// ── 1) 书架：空态 ────────────────────────────────────────
const shelfProps = {
  api: fakeApi(),
  t,
  books: [],
  busy: false,
  dragging: false,
  // 网页书源（2026-10-19 新增）带来的必需 props。缺它会直接崩在 webJobs.length，
  // 而组件本身已对缺省做兜底（ShelfView 的默认参数），这里仍显式传空数组：
  // 测试要覆盖组件**真实契约**，不能靠兜底把契约漂移掩盖过去。
  webJobs: [],
  onDragStateChange: noop,
  onImport: noop,
  onOpen: noop,
  onRemove: noop,
  onAddWebSource: noop,
  onResumeWebJob: noop,
  onStopWebJob: noop,
  onDismissWebJob: noop,
};
const emptyShelf = render('空书架', createElement(ShelfView, shelfProps));
check('空书架渲染不抛错', emptyShelf.error === undefined, emptyShelf.error);
check('空书架显示空态文案', emptyShelf.html.includes(zh['shelf.empty']), undefined);
check('空书架带拖拽提示', emptyShelf.html.includes(zh['shelf.empty.hint']));
check('空书架有导入按钮', emptyShelf.html.includes(zh['shelf.import']));

// ── 2) 书架：有书（真实封面 / 生成式封面 / 进度 / 划线数）──
const withBooks = render(
  '有书书架',
  createElement(ShelfView, {
    ...shelfProps,
    books: [
      makeEntry({ title: '有封面的书', hasCover: true, progress: { anchor: 'v2;chapter=1;page=2;pct=40', percent: 42.5, updatedAt: 1 } }),
      makeEntry({ title: '无封面的书', hasCover: false, highlightCount: 3 }),
      makeEntry({ title: '文本书', format: 'txt' }),
    ],
  }),
);
check('有书书架渲染不抛错', withBooks.error === undefined, withBooks.error);
check('渲染出书卡网格', withBooks.html.includes('dsh-reading-grid'));
check('有封面时用真实封面 <img>', withBooks.html.includes('dsh-reading-coverimg') && withBooks.html.includes('api/reading-workbench/cover'));
check('无封面时回落生成式封面', withBooks.html.includes('dsh-reading-gencover'));
check('生成式封面带书名', withBooks.html.includes('无封面的书'));
check('显示进度百分比', withBooks.html.includes('42%'), undefined);
check('显示划线数', withBooks.html.includes('· 3'));
check('显示格式徽标', withBooks.html.includes('>EPUB<') || withBooks.html.includes('EPUB'));
check('书卡带移除按钮', withBooks.html.includes(zh['shelf.remove']));

// ── 3) 书架：搜索无结果 ──────────────────────────────────
// 直接给一个搜索词无法注入（组件内部 state），改验证非空列表下不崩
const manyBooks = render(
  '多书书架',
  createElement(ShelfView, {
    ...shelfProps,
    books: Array.from({ length: 30 }, (_, i) => makeEntry({ title: `第 ${i + 1} 本` })),
  }),
);
check('30 本书渲染不抛错', manyBooks.error === undefined, manyBooks.error);
check('30 本书都渲染出卡片', (manyBooks.html.match(/dsh-reading-card"/g) ?? []).length === 30, `实际 ${(manyBooks.html.match(/dsh-reading-card"/g) ?? []).length}`);

// ── 4) 阅读器：EPUB（初始加载态）────────────────────────
const readerProps = {
  api: fakeApi(),
  t,
  book: makeEntry({ title: '阅读中的书' }).book,
  settings: { fontSize: 17, lineHeight: 1.9, theme: 'follow', columns: 'auto' },
  progress: undefined,
  onSettingsChange: noop,
  onBack: noop,
};
const epubReader = render('EPUB 阅读器', createElement(ReaderView, readerProps));
check('EPUB 阅读器渲染不抛错', epubReader.error === undefined, epubReader.error);
check('阅读器显示书名', epubReader.html.includes('阅读中的书'));
check('阅读器有返回书架按钮', epubReader.html.includes(zh['reader.back']));
check('阅读器有三档版式切换', epubReader.html.includes(zh['reader.layout.one']) && epubReader.html.includes(zh['reader.layout.two']) && epubReader.html.includes(zh['reader.layout.auto']));
check('阅读器有字号调整', epubReader.html.includes('A－') && epubReader.html.includes('A＋'));

// ── 5) 阅读器：TXT / PDF / MOBI 都不崩 ───────────────────
for (const format of ['txt', 'md', 'html', 'mobi']) {
  const result = render(
    `${format} 阅读器`,
    createElement(ReaderView, { ...readerProps, book: makeEntry({ title: `${format} 书`, format }).book }),
  );
  check(`${format.toUpperCase()} 阅读器渲染不抛错`, result.error === undefined, result.error);
  check(`${format.toUpperCase()} 阅读器显示书名`, result.html.includes(`${format} 书`));
}
const pdfReader = render('PDF 阅读器', createElement(ReaderView, { ...readerProps, book: makeEntry({ title: 'PDF 书', format: 'pdf' }).book }));
check('PDF 阅读器渲染不抛错', pdfReader.error === undefined, pdfReader.error);
check('PDF 阅读器显示书名', pdfReader.html.includes('PDF 书'));

// ── 6) 阅读器：设置变化不崩（单页 / 双页 / 字号）─────────
for (const columns of [1, 2, 'auto']) {
  const result = render(
    `columns=${columns}`,
    createElement(ReaderView, {
      ...readerProps,
      settings: { fontSize: 24, lineHeight: 2.2, theme: 'follow', columns },
    }),
  );
  check(`版式 ${columns} 渲染不抛错`, result.error === undefined, result.error);
}

// ── 7) 空/异常书名不崩 ───────────────────────────────────
const weird = render(
  '异常书名',
  createElement(ShelfView, {
    ...shelfProps,
    books: [makeEntry({ title: '', author: '' }), makeEntry({ title: '很长的书名'.repeat(40) })],
  }),
);
check('空书名 / 超长书名不崩', weird.error === undefined, weird.error);

// ── 8) 界面文案完整性哨兵（防编码损坏 / 词典缺键悄悄上线）──
// 曾发生：PowerShell 的 ANSI 往返把中文串烧成替换字符，UI 上直接显示成问号方块。
// 注意：判定用的字符通过 String.fromCharCode / 拼接生成，避免本文件自己被全库扫描误报。
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const BROKEN_PLACEHOLDER = '\u3010' + '\u3011'; // 【】
check('返回书架按钮文案完好', epubReader.html.includes('‹') && epubReader.html.includes(zh['reader.back']), zh['reader.back']);
check('字号按钮文案完好（A－ / A＋）', epubReader.html.includes('A－') && epubReader.html.includes('A＋'));
check('书架导入按钮文案完好', withBooks.html.includes(zh['shelf.import']), zh['shelf.import']);
const allHtml = [emptyShelf.html, withBooks.html, manyBooks.html, epubReader.html, pdfReader.html, weird.html].join('');
check('渲染产物不含替换字（编码损坏哨兵）', !allHtml.includes(REPLACEMENT_CHAR));
check('渲染产物不含损坏占位符', !allHtml.includes(BROKEN_PLACEHOLDER));

console.log(allPass ? '\nUI 渲染冒烟全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
