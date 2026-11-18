/**
 * Agent 工具自测：加载 lib 产物，验证三个工具在**真实 dsh-tools 管线**下的行为。
 *
 * 为什么不用临时假 ctx：defineTool 会做 schema 编译与参数校验，
 * 用真实实现才能暴露「schema 写错 / 输出不符声明」这类问题。
 *
 * 覆盖：
 * - 注册形态（数组、disposer 可调用）；
 * - reading_books：execute 输出符合声明 schema；空书架 render；
 * - reading_highlights：过滤、倒序、limit、笔记可选；
 * - reading_excerpt：md 全文、HTML 剥离、offset/length 截取、越界、未知书 id 报错。
 *
 * 用法：node scripts/tools-selftest.mjs
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshHome = await mkdtemp(join(tmpdir(), 'rw-tools-selftest-'));
// 直接加载源码（node 24 类型擦除），并注入 tools 桩以驱动 register
const { registerReadingTools } = await import('../src/tools.ts');
const { resolveStorePaths } = await import('../src/store.ts');

const paths = resolveStorePaths(dshHome);
await mkdir(join(paths.libraryDir), { recursive: true });

/** 注册桩：与真实宿主同签名 —— register(definition) 只收单个工具。
 *  曾因插件传数组导致宿主启动失败（fiberPhase: failed），这里对数组直接抛错以防回归。 */
function makeToolsHost() {
  const registered = [];
  let disposed = false;
  return {
    registered,
    get disposed() {
      return disposed;
    },
    tools: {
      register(definition) {
        if (Array.isArray(definition)) {
          throw new TypeError('tools.register 只接受单个工具定义（ToolDefinition），不接受数组');
        }
        registered.push(definition);
        return () => {
          disposed = true;
        };
      },
    },
  };
}

const host = makeToolsHost();
const disposer = registerReadingTools(host, paths);

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

check('注册了 3 个工具', host.registered.length === 3, host.registered.map((tool) => tool.name).join(', '));
check('disposer 可调用且标记撤销', typeof disposer === 'function' && !host.disposed);
disposer();
check('disposer 撤销语义正确', host.disposed);

/**
 * 无损 JSON 判据：与宿主 `snapshotJsonValue` 的拒绝条件对齐。
 *
 * 2026-10-19 真机事故：`reading_books` 对无作者的书返回 `author: undefined`，
 * 宿主判成「value is not lossless JSON」，整次工具调用失败（书架 24 本里有 2 本无作者）。
 * 这里的规则比 JSON.stringify 更严——序列化丢键看似无害，但宿主拒绝的是「不可无损往返」。
 */
function losslessViolations(value, path = '$', seen = new Set()) {
  const bad = [];
  if (value === null) return bad;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return bad;
  if (type === 'number') {
    if (!Number.isFinite(value)) bad.push(`${path} 不是有限数字`);
    return bad;
  }
  if (type === 'undefined') {
    bad.push(`${path} 是 undefined`);
    return bad;
  }
  if (type !== 'object') {
    bad.push(`${path} 类型 ${type} 不可序列化`);
    return bad;
  }
  if (seen.has(value)) {
    bad.push(`${path} 循环引用`);
    return bad;
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    bad.push(`${path} 是类实例（${proto?.constructor?.name ?? 'unknown'}）`);
    return bad;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) bad.push(`${path}[${i}] 是数组空洞`);
      else bad.push(...losslessViolations(value[i], `${path}[${i}]`, seen));
    }
  } else {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) bad.push(`${path}.${key} 是 undefined`);
      else bad.push(...losslessViolations(value[key], `${path}.${key}`, seen));
    }
  }
  seen.delete(value);
  return bad;
}

/** 对一次工具输出同时跑无损判据，打印一行结论。 */
function checkLossless(label, value) {
  const violations = losslessViolations(value);
  check(`${label} 输出是无损 JSON`, violations.length === 0, violations.slice(0, 3).join('; '));
  return violations.length === 0;
}

// 判据自检：故意构造宿主会拒绝的值，确保这条判据不是「永远返回空数组」的假断言
{
  const cases = [
    ['undefined 属性', { books: [{ id: 'x', title: 'y', author: undefined, format: 'md' }] }],
    ['NaN', { percent: Number.NaN }],
    ['Date 实例', { at: new Date() }],
    ['数组空洞', { items: [1, , 3] }],
  ];
  for (const [label, sample] of cases) {
    check(`判据能抓到 ${label}（自检）`, losslessViolations(sample).length > 0);
  }
}

// 重新注册供后续用例
const disposer2 = registerReadingTools(host, paths);
const tools = new Map(host.registered.slice(-3).map((tool) => [tool.name, tool]));
const fakeExec = { agent: undefined, signal: undefined, call: async () => ({}) };

/** 造数据：两本书 + 三条划线（跨两本书，乱序时间戳）。 */
async function seed() {
  // 书 1：md 文本
  const book1 = { id: 'book-md', title: '测试文本书', author: '甲', sourcePath: 'upload:x.md', format: 'md', addedAt: 1 };
  await writeFile(join(paths.libraryDir, 'book-md.md'), '# 第一章\n\n床前明月光，疑是地上霜。\n\n举头望明月，低头思故乡。', 'utf8');
  // 书 2：epub（正文在 book.html）
  const book2 = { id: 'book-epub', title: '测试电子书', sourcePath: 'upload:y.epub', format: 'epub', addedAt: 2 };
  await mkdir(join(paths.libraryDir, 'book-epub'), { recursive: true });
  await writeFile(join(paths.libraryDir, 'book-epub', 'book.html'), '<html><body><h1>第一章</h1><p>电子书正文，<img src="a.png">带图片。</p></body></html>', 'utf8');
  const data = {
    schemaVersion: 1,
    books: [book1, book2],
    progress: { 'book-md': { anchor: 'v2;page=1;pct=50', percent: 50, updatedAt: 1 } },
    highlights: [
      { id: 'h1', bookId: 'book-md', text: '床前明月光', note: '名句', anchor: 'mark:off=5:len=5', createdAt: 30 },
      { id: 'h2', bookId: 'book-md', text: '低头思故乡', anchor: 'mark:off=20:len=5', createdAt: 20 },
      { id: 'h3', bookId: 'book-epub', text: '电子书正文', anchor: 'mark:ch=0:off=9:len=5', createdAt: 10 },
    ],
    settings: { reader: { fontSize: 17, lineHeight: 1.9, theme: 'follow', columns: 'auto' } },
  };
  await writeFile(join(paths.dir, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
  return { book1, book2 };
}

const { book1, book2 } = await seed();

// ── 1) reading_books ──
{
  const tool = tools.get('reading_books');
  check('reading_books 参数编译为 object 根', tool.parameters.type === 'object' && tool.parameters.properties !== undefined, Object.keys(tool.parameters).join(','));
  check('reading_books 无必填参数', (tool.parameters.required ?? []).length === 0);
  // 宿主 registry 强制 structured output 以 object 为根（assertObjectJsonSchema），
  // 数组根会在注册时抛 JsonSchemaError、插件 fiber 失败（曾导致重启后全部路由 404）。
  check('output.schema 以 object 为根（宿主强制）', tool.output.schema.type === 'object', `type=${tool.output.schema.type}`);
  const result = await tool.execute({}, fakeExec);
  const books = result.books;
  check('reading_books 返回两本', books.length === 2, `共 ${books.length}`);
  check('书 1 带进度', books.find((b) => b.id === 'book-md')?.percent === 50);
  check('书 2 无进度（字段缺省）', books.find((b) => b.id === 'book-epub')?.percent === undefined);
  // 事故回归：无作者的书必须**省略 author 键**，不能留 author: undefined
  check('书 2 无作者（键必须省略）', !Object.hasOwn(books.find((b) => b.id === 'book-epub'), 'author'));
  checkLossless('reading_books', result);
  const rendered = tool.output.render({}, result);
  check('render 产出文本块', rendered.length === 1 && rendered[0].type === 'text');
  check('render 含书名与进度', rendered[0].text.includes('《测试文本书》') && rendered[0].text.includes('50%'), rendered[0].text.slice(0, 60));
}

// ── 2) reading_highlights ──
{
  const tool = tools.get('reading_highlights');
  check('划线工具参数可选（无 required）', Object.values(tool.parameters).every((p) => p.required !== true));

  const all = await tool.execute({}, fakeExec);
  check('全部划线按时间倒序', all.items.map((i) => i.text).join(',') === '床前明月光,低头思故乡,电子书正文', all.items.map((i) => i.text).join(','));
  check('总数正确', all.total === 3);

  const onlyMd = await tool.execute({ bookId: 'book-md' }, fakeExec);
  check('按书过滤', onlyMd.total === 2 && onlyMd.items.every((i) => i.bookTitle === '测试文本书'));

  const limited = await tool.execute({ limit: 1 }, fakeExec);
  check('limit 生效（取最新一条）', limited.items.length === 1 && limited.items[0].text === '床前明月光');

  const withNote = all.items.find((i) => i.text === '床前明月光');
  check('笔记字段保留', withNote?.note === '名句');
  const withoutNote = all.items.find((i) => i.text === '低头思故乡');
  check('无笔记字段缺省', withoutNote?.note === undefined);

  const rendered = tool.output.render({}, all);
  check('render 含书名与笔记', rendered[0].text.includes('《测试文本书》') && rendered[0].text.includes('名句'));
  checkLossless('reading_highlights', all);
}

// ── 3) reading_excerpt ──
{
  const tool = tools.get('reading_excerpt');

  // md 全文（默认区间）
  const mdFull = await tool.execute({ bookId: 'book-md' }, fakeExec);
  check('md 正文原样保留（Markdown 不剥离）', mdFull.excerpt.startsWith('# 第一章'), mdFull.excerpt.slice(0, 20));
  check('md 全长与 hasMore', mdFull.totalLength > 0 && mdFull.hasMore === false);
  checkLossless('reading_excerpt', mdFull);

  // md 分段截取（逐字符数：# 、第、一、章、\n、\n、床、前 = 8 字符）
  const mdSlice = await tool.execute({ bookId: 'book-md', offset: 0, length: 8 }, fakeExec);
  check('offset/length 截取（含换行逐字符计数）', mdSlice.excerpt === '# 第一章\n\n床', JSON.stringify(mdSlice.excerpt));
  check('截取后仍有余量', mdSlice.hasMore === true);

  // epub：HTML 剥离 + 图片占位
  const epubText = await tool.execute({ bookId: 'book-epub' }, fakeExec);
  check('epub 剥离 HTML 标签', epubText.excerpt.includes('第一章') && !epubText.excerpt.includes('<h1>'), epubText.excerpt.slice(0, 40));
  check('epub 图片替换为占位', epubText.excerpt.includes('[图片]'), epubText.excerpt.slice(0, 40));

  // 越界 offset：安全返回空片段
  const beyond = await tool.execute({ bookId: 'book-md', offset: 99999 }, fakeExec);
  check('越界 offset 返回空片段', beyond.excerpt === '' && beyond.hasMore === false);

  // 未知书 id：明确报错
  let threw = '';
  try {
    await tool.execute({ bookId: 'no-such-book' }, fakeExec);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('未知书 id 明确报错', threw.includes('reading_books'), threw.slice(0, 60));
}

await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\nAgent 工具自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
