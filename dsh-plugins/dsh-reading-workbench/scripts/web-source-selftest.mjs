/**
 * 网页书源自测（不依赖 DSH、不依赖网络）。
 *
 * 覆盖四层：
 * 1. HTML 文本工具的纯函数行为（实体、剥标签、标签配平、属性读取）；
 * 2. `alicesw` 适配器对**真实落盘样本**的解析（选择器、章名、正文、下一章链）；
 * 3. 适配器判定的**反证**：正文缺失 / 过短必须抛错，不能静默返回空章；
 * 4. 抓取编排（建书 → 续抓 → 幂等 → 目录懒扩展 → 单章失败不阻断），用假抓取函数完全离线跑。
 *
 * 样本来源：`docs/web-source/samples/`（真实站点裁剪样本，见该目录 README）。
 * 用法：node scripts/web-source-selftest.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aliceswAdapter,
  decodeEntities,
  extractBodyParagraphs,
  findEnclosingDiv,
  readAttribute,
  selectAdapter,
  stripTags,
} from '../src/web-source.ts';
import { fetchWebChapters, importWebBook, readWebStatus } from '../src/web-import.ts';
import { builtinFetchHtml } from '../src/web-fetch-fallback.ts';
import { loadData, readEpubManifest, readWebState } from '../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
// scripts → reading-workbench → plugins → dsh-plugin（工作区根），样本放在工作区 docs/web-source/samples
const repoRoot = join(here, '..', '..', '..');
const samples = join(repoRoot, 'docs', 'web-source', 'samples');

let allPass = true;
let total = 0;
/** 断言并打印。 */
function check(name, condition, detail) {
  total += 1;
  allPass = allPass && Boolean(condition);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 断言某个函数调用会抛错，并返回错误消息。 */
async function expectThrow(name, fn) {
  try {
    await fn();
    check(name, false, '（期望抛错，实际成功返回）');
    return '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, true, message.slice(0, 80));
    return message;
  }
}

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------
console.log('\n=== 1. HTML 文本工具 ===');
check('decodeEntities 命名实体', decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f') === 'a&b<c>d"e\'f');
check('decodeEntities 十进制', decodeEntities('&#20320;&#22909;') === '你好');
check('decodeEntities 十六进制', decodeEntities('&#x4f60;&#x597d;') === '你好');
check('decodeEntities 未知实体原样保留', decodeEntities('&unknownentity;') === '&unknownentity;');
check('stripTags 剥标签 + 反转义', stripTags('<p>\u3000\u3000a&amp;b</p>') === '\u3000\u3000a&b');
check(
  'stripTags 不折叠内部空白（章名「第一千二百二十七章  大結局」保真）',
  stripTags('<h3>第一千二百二十七章  大結局</h3>') === '第一千二百二十七章  大結局',
);

const nested = '<div id="root"><div class="a">x</div><div class="b">y</div></div><div>after</div>';
{
  const markerIndex = nested.indexOf('class="a"');
  const range = findEnclosingDiv(nested, markerIndex);
  const inside = range === undefined ? '' : nested.slice(range.start, range.end);
  check('findEnclosingDiv 定位到正确的内层 div', inside === '<div class="a">x</div>', JSON.stringify(inside));
}
{
  const markerIndex = nested.indexOf('id="root"');
  const range = findEnclosingDiv(nested, markerIndex);
  const inside = range === undefined ? '' : nested.slice(range.start, range.end);
  check(
    'findEnclosingDiv 能配平嵌套层级（取到整块而不是第一个 </div>）',
    inside === '<div id="root"><div class="a">x</div><div class="b">y</div></div>',
    `${inside.length} 字符`,
  );
}
check('findEnclosingDiv 无匹配返回 undefined', findEnclosingDiv(nested, nested.indexOf('after')) !== undefined);
check('readAttribute 双引号', readAttribute('<div data-nurl="/book/1/2.html">', 'data-nurl') === '/book/1/2.html');
check('readAttribute 单引号', readAttribute("<div data-nurl='/a.html'>", 'data-nurl') === '/a.html');
check('readAttribute 属性缺失返回 undefined', readAttribute('<div>', 'data-nurl') === undefined);

// ---------------------------------------------------------------------------
// 2. 站点适配器判定
// ---------------------------------------------------------------------------
console.log('\n=== 2. selectAdapter ===');
check('www.alicesw.tw 命中', selectAdapter('https://www.alicesw.tw/other/chapters/id/35434.html')?.id === 'alicesw');
check('alicesw.com 命中', selectAdapter('https://alicesw.com/novel/35434.html')?.id === 'alicesw');
check('xchina.co 不命中（尚未支持）', selectAdapter('https://xchina.co/fiction/6a9c7a8ab3286') === undefined);
check('非法 URL 返回 undefined', selectAdapter('not-a-url') === undefined);

// ---------------------------------------------------------------------------
// 3. 真实样本解析
// ---------------------------------------------------------------------------
console.log('\n=== 3. alicesw 适配器 + 真实落盘样本 ===');
const catalogHtml = await readFile(join(samples, 'alicesw_35434.html'), 'utf8');
const catalogPage = { html: catalogHtml, truncated: true };
/** 假的抓取函数：按 URL → 本地样本映射，未登记的直接抛错（保证测试不打网络）。 */
function sampleFetcher(map) {
  return async (url) => {
    const value = map[url];
    if (value === undefined) throw new Error(`测试夹具缺失：${url}`);
    return typeof value === 'string' ? { html: value, truncated: false } : value;
  };
}

{
  const catalog = await aliceswAdapter.fetchCatalog(
    sampleFetcher({}),
    'https://www.alicesw.tw/other/chapters/id/35434.html',
    catalogPage,
  );
  check('目录页解析出 1221 章', catalog.chapters.length === 1221, `实测 ${catalog.chapters.length}`);
  check('站点标识为 alicesw', catalog.siteId === 'alicesw');
  check('书名非空', catalog.title.trim() !== '', catalog.title);
  check('首章 index/标题/URL 正确', catalog.chapters[0]?.index === 0 && catalog.chapters[0]?.title.startsWith('第一章'));
  check(
    '章节 URL 绝对化正确',
    catalog.chapters[0]?.url.startsWith('https://www.alicesw.tw/book/36990/'),
    catalog.chapters[0]?.url,
  );
  const uniqueUrls = new Set(catalog.chapters.map((chapter) => chapter.url));
  check('章节 URL 无重复', uniqueUrls.size === catalog.chapters.length, `唯一 ${uniqueUrls.size}`);
}

const chapterSample = await readFile(join(samples, 'alicesw_ch_a3c7f8d5a55cf.html'), 'utf8');
const chapterUrl = 'https://www.alicesw.tw/book/36990/a3c7f8d5a55cf.html';

{
  // ① 定位层：只认正文容器内的 <p>，不能把导航/页脚的 <p> 也算进来
  // （真实页面的 div 并不配平：48 个 <div 对 45 个 </div>，靠配平划范围会失败并退化成整页扫描）
  const paragraphs = extractBodyParagraphs(chapterSample);
  const wholePageParagraphs = [...chapterSample.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].length;
  check('正文段落定位到 3 段（裁剪样本保留了 3 段）', paragraphs.length === 3, `实测 ${paragraphs.length}`);
  check(
    '没有把导航/页脚的 <p> 混进正文（整页 <p> 数远多于正文段数）',
    wholePageParagraphs > paragraphs.length,
    `整页 ${wholePageParagraphs} vs 正文 ${paragraphs.length}`,
  );
  check(
    '正文段首段是正文内容而非导航文字',
    paragraphs[0] === '一九六零年冬。',
    JSON.stringify(paragraphs[0]),
  );
  check(
    '正文里没有混入导航词',
    paragraphs.every((text) => !/分類|最新章節|使用手機掃碼/.test(text)),
  );
}

{
  // ② 阈值层（反证）：裁剪样本正文只有 40 字，低于 50 字阈值 → 必须抛错而不是静默返空章
  const message = await expectThrow('正文不足阈值时必须抛错（防「抓到空壳页还入库」）', () =>
    aliceswAdapter.fetchChapter(sampleFetcher({ [chapterUrl]: chapterSample }), {
      index: 0,
      title: '第一章',
      url: chapterUrl,
    }),
  );
  check('抛错信息里带 URL 便于定位', message.includes(chapterUrl));
}

{
  // ③ 完整链路：把正文段落复制 5 份补足字数，验证标题 / 段落 / 下一章链都取对
  const baseParagraphs = extractBodyParagraphs(chapterSample);
  const pumped = `<html><head><meta charset="utf-8"></head><body>
    <h3 class="j_chapterName">第一章 测试章名</h3>
    <div id="j_chapterBox"><div class="text-wrap" data-cid="a3c7f8d5a55cf"
      data-nurl="/book/36990/8e2f3f2305713.html">
      <div class="main-text-wrap"><div class="read-content j_readContent">
        ${baseParagraphs.map((text) => `<p>${text}</p>`).join('').repeat(5)}
      </div></div>
    </div></div>
  </body></html>`;
  const body = await aliceswAdapter.fetchChapter(sampleFetcher({ [chapterUrl]: pumped }), {
    index: 0,
    title: '目录标题',
    url: chapterUrl,
  });
  check('章标题取自 h3.j_chapterName', body.title === '第一章 测试章名', body.title);
  check('正文段落数 = 3×5', body.paragraphs.length === 15, `实测 ${body.paragraphs.length}`);
  check('段落已去首尾空白', body.paragraphs.every((text) => text === text.trim()));
  check('段落不含 HTML 标签', body.paragraphs.every((text) => !text.includes('<')));
  check(
    'nextUrl 取自 data-nurl 并绝对化',
    body.nextUrl === 'https://www.alicesw.tw/book/36990/8e2f3f2305713.html',
    body.nextUrl,
  );
}

{
  // 末章：目录顺序里的最后一章没有「下一章」，data-nurl 为空串
  const lastUrl = 'https://www.alicesw.tw/book/36990/e148f7a5dccfe.html';
  const lastSample = await readFile(join(samples, 'alicesw_ch_e148f7a5dccfe.html'), 'utf8');
  const baseParagraphs = extractBodyParagraphs(lastSample);
  const pumped = `<html><body>
    <h3 class="j_chapterName">末章</h3>
    <div class="text-wrap" data-nurl="">
      <div class="read-content">${baseParagraphs.map((text) => `<p>${text}</p>`).join('').repeat(3)}</div>
    </div></body></html>`;
  const body = await aliceswAdapter.fetchChapter(sampleFetcher({ [lastUrl]: pumped }), {
    index: 1220,
    title: '末章',
    url: lastUrl,
  });
  check('末章 nextUrl 为 undefined（空串不产生 URL）', body.nextUrl === undefined, String(body.nextUrl));
}

{
  // 站点改版的最坏情况：页面里根本没有正文容器
  await expectThrow('无正文容器的页面必须抛错', () =>
    aliceswAdapter.fetchChapter(
      sampleFetcher({ [chapterUrl]: '<html><body><h1>404</h1></body></html>' }),
      { index: 0, title: 'x', url: chapterUrl },
    ),
  );
}

// ---------------------------------------------------------------------------
// 3.5 内置抓取通道的准入校验
//
// 这些检查都在**发请求之前**完成（URL 解析 → 协议 → 域名白名单），所以能离线断言，
// 不会给 `pnpm check` 引入网络依赖。
// ---------------------------------------------------------------------------
console.log('\n=== 3.5 内置抓取通道准入（不产生网络请求） ===');
{
  /** 断言某个 URL 被以指定 code 拒绝。 */
  async function expectCode(name, url, code) {
    try {
      await builtinFetchHtml(url);
      check(name, false, '（期望被拒绝，实际通过）');
    } catch (error) {
      const actual = error && error.code;
      check(name, actual === code, `code=${actual}`);
    }
  }
  await expectCode('非法 URL 被拒', 'not-a-url', 'BUILTIN_FETCH_INVALID_URL');
  await expectCode('非 https 被拒', 'http://www.alicesw.tw/other/chapters/id/1.html', 'BUILTIN_FETCH_BLOCKED_SCHEME');
  await expectCode('白名单外域名被拒', 'https://example.com/', 'BUILTIN_FETCH_BLOCKED_HOST');
  await expectCode('伪装子域被拒（alicesw.tw.evil.com）', 'https://alicesw.tw.evil.com/', 'BUILTIN_FETCH_BLOCKED_HOST');
  await expectCode('环回地址被拒', 'https://127.0.0.1/x', 'BUILTIN_FETCH_BLOCKED_HOST');
  await expectCode('内网地址被拒', 'https://192.168.1.1/x', 'BUILTIN_FETCH_BLOCKED_HOST');
}

// ---------------------------------------------------------------------------
// 4. 抓取编排（假抓取，完全离线）
// ---------------------------------------------------------------------------
console.log('\n=== 4. 抓取编排（建书 / 续抓 / 幂等 / 目录懒扩展） ===');
const sandboxDir = await mkdtemp(join(tmpdir(), 'dsh-web-source-selftest-'));
const paths = {
  dir: sandboxDir,
  file: join(sandboxDir, 'data.json'),
  libraryDir: join(sandboxDir, 'library'),
};

/** 构造一个最小但合法的目录页（3 章，够测懒扩展）。 */
function makeCatalogHtml(count) {
  const items = Array.from({ length: count }, (_unused, index) => {
    const id = `ch${String(index).padStart(3, '0')}`;
    return `<li><a href="/book/99999/${id}.html">第${index + 1}章 测试章节</a></li>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    <div class="mu_h1"><h1>测试网页书</h1></div>
    <div class="infos"><span><a href="/search.html?q=a">测试作者</a></span></div>
    <ul class="mulu_list">${items}</ul>
  </body></html>`;
}

/** 构造一个合法章节页；`nextUrl` 为空串表示末章。 */
function makeChapterHtml(index, nextUrl) {
  const body = `<p>　　这是第 ${index + 1} 章的正文内容，用来满足最少字数阈值，确保解析成功而不是被当成空章丢弃。</p>`.repeat(3);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    <h3 class="j_chapterName">第${index + 1}章 测试章节</h3>
    <div id="j_chapterBox"><div class="text-wrap" data-cid="ch${String(index).padStart(3, '0')}"
      data-purl="" data-nurl="${nextUrl}">
      <div class="main-text-wrap"><div class="read-content j_readContent">${body}</div></div>
    </div></div>
  </body></html>`;
}

try {
  // 目录页只给 2 章（模拟「被抓取后端截断」），第 3 章只能靠 data-nurl 链发现
  const entryUrl = 'https://www.alicesw.tw/other/chapters/id/99999.html';
  const fixture = new Map();
  fixture.set(entryUrl, { html: makeCatalogHtml(2), truncated: true });
  for (let index = 0; index < 3; index += 1) {
    const next = index < 2 ? `/book/99999/ch${String(index + 1).padStart(3, '0')}.html` : '';
    fixture.set(`https://www.alicesw.tw/book/99999/ch${String(index).padStart(3, '0')}.html`, {
      html: makeChapterHtml(index, next),
      truncated: false,
    });
  }
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    const value = fixture.get(url);
    if (value === undefined) throw new Error(`测试夹具缺失：${url}`);
    return value;
  };

  const imported = await importWebBook(paths, fakeFetch, entryUrl);
  check('建书成功', imported.book.id.length > 0);
  check('书目 format 为 web', imported.book.format === 'web');
  check('书目 source 为 web 且带 sourceUrl', imported.book.source === 'web' && imported.book.sourceUrl === entryUrl);
  check('sourcePath 用 web: 伪路径', imported.book.sourcePath === `web:${entryUrl}`, imported.book.sourcePath);
  check('建书时抓了首章', imported.fetched === 1, `fetched=${imported.fetched}`);
  check('目录总数为 2（截断后的目录）', imported.total === 2, `total=${imported.total}`);
  check('截断会给出 warning', imported.warnings.length > 0, imported.warnings.join(' / '));

  const manifestAfterImport = await readEpubManifest(paths, imported.book);
  check('manifest 可被 readEpubManifest 读回', manifestAfterImport !== undefined && manifestAfterImport.chapters.length === 2);
  check('manifest 章节 index 与下标一致', manifestAfterImport.chapters.every((chapter, index) => chapter.index === index));

  // 首章文件可直接用 /content?chapter=0 的路径读到
  const chapterFile = join(paths.libraryDir, imported.book.id, manifestAfterImport.chapters[0].href);
  const chapterHtml = await readFile(chapterFile, 'utf8');
  check('首章落盘为 <p> 包裹的纯文本', chapterHtml.includes('<p>') && !chapterHtml.includes('<script'));

  // 续抓：目录里还有 1 章 + 懒扩展会再发现 1 章
  const round2 = await fetchWebChapters(paths, fakeFetch, imported.book.id, 5);
  check('续抓补完目录内章节', round2.fetched >= 1, `fetched=${round2.fetched}`);
  const manifestAfterExtend = await readEpubManifest(paths, imported.book);
  check('目录懒扩展把第 3 章补进来', manifestAfterExtend.chapters.length === 3, `chapters=${manifestAfterExtend.chapters.length}`);
  const status2 = await readWebStatus(paths, imported.book.id);
  check('状态 total 同步为 3', status2.total === 3, `total=${status2.total}`);
  const state2 = await readWebState(paths, imported.book);
  check('web.json 记录了 3 个源 URL', state2.urls.length === 3, `urls=${state2.urls.length}`);

  // 第 3 轮：抓懒扩展补进来的第 3 章，抓完目录即到末章
  const round3 = await fetchWebChapters(paths, fakeFetch, imported.book.id, 5);
  check(
    '第 3 轮抓完懒扩展补进来的第 3 章',
    round3.fetched === 1 && round3.pending === 0,
    `fetched=${round3.fetched} pending=${round3.pending}`,
  );

  // 第 4 轮：幂等，不应新增文件也不应重复扩目录
  const callsBefore = calls;
  const round4 = await fetchWebChapters(paths, fakeFetch, imported.book.id, 5);
  check('已抓完时续抓为空操作', round4.fetched === 0, `fetched=${round4.fetched}`);
  check('幂等：没有发起多余的网络请求', calls === callsBefore, `calls ${callsBefore} → ${calls}`);
  check('幂等：目录没有重复扩展', (await readEpubManifest(paths, imported.book)).chapters.length === 3);
  check('全部抓完后 pending 为 0', round4.pending === 0, `pending=${round4.pending}`);

  const dataAfter = await loadData(paths);
  check('data.json 只有 1 本书（未重复入库）', dataAfter.books.length === 1);
  check('书目带 fetchedAt', typeof dataAfter.books[0].fetchedAt === 'number');
  const status3 = await readWebStatus(paths, imported.book.id);
  check('状态查询返回 fetched=3', status3.fetched === 3, `fetched=${status3.fetched}`);

  // 单章失败不阻断：把第 2 章换成无正文页面
  {
    const failFixture = new Map(fixture);
    failFixture.set('https://www.alicesw.tw/book/99999/ch001.html', {
      html: '<html><body>空</body></html>',
      truncated: false,
    });
    const failFetch = async (url) => failFixture.get(url) ?? { html: '<html></html>', truncated: false };
    const imported2 = await importWebBook(
      paths,
      async (url) => (url === entryUrl ? { html: makeCatalogHtml(2), truncated: false } : failFetch(url)),
      entryUrl,
    );
    const result = await fetchWebChapters(paths, failFetch, imported2.book.id, 5);
    check('失败的章进入 errors 而不是抛错', result.errors.length > 0, `errors=${result.errors.length}`);
    check('errors 里带章序与中文说明', typeof result.errors[0].index === 'number' && result.errors[0].message.length > 0);
  }

  // 目录页被截断 ⇒ 应自动用「无字符上限的补充通道」重抓完整目录
  {
    const truncatedOnly = async (url) => (url === entryUrl ? { html: makeCatalogHtml(2), truncated: true } : failSafe(url));
    function failSafe(url) {
      return fixture.get(url) ?? { html: '<html></html>', truncated: false };
    }
    const supplement = async (url) => (url === entryUrl ? { html: makeCatalogHtml(4), truncated: false } : failSafe(url));
    const imported3 = await importWebBook(paths, truncatedOnly, entryUrl, { supplement });
    check('截断目录被补充通道补全为 4 章', imported3.total === 4, `total=${imported3.total}`);
    check(
      'warnings 说明换了无字符上限的通道重抓',
      imported3.warnings.some((text) => text.includes('完整目录')),
      imported3.warnings.join(' / '),
    );
    // 反证：不提供补充通道时，只能按截断目录建书（2 章）
    const imported4 = await importWebBook(paths, truncatedOnly, entryUrl);
    check('没有补充通道时按截断目录建书（2 章）', imported4.total === 2, `total=${imported4.total}`);
  }

  // 不支持的站点必须给出明确中文提示（不能静默建一本空书）
  await expectThrow('不支持的站点直接拒绝', () => importWebBook(paths, fakeFetch, 'https://xchina.co/fiction/1'));
} finally {
  await rm(sandboxDir, { recursive: true, force: true });
}

console.log(`\n=== 汇总：${total} 项，${allPass ? '全部通过' : '存在失败'} ===`);
if (!allPass) process.exitCode = 1;
