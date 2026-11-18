/**
 * 网页书源**HTTP 路由级**验收（离线、可重复运行）。
 *
 * 为什么需要这一层：`web-source-selftest.mjs` 覆盖的是函数层（适配器 / 编排 / 纯逻辑），
 * 而真实故障发生在**路由面**上 —— 用户实测「续抓一轮都没发出去」「点第 2 章报
 * chapter file missing」，函数层全绿也照样出问题。本套件把 `makeRoutes` 挂到真实
 * `node:http` 服务上，用真实 HTTP 往返验证：
 *
 * 1. `POST /sources/web` 建书；
 * 2. `GET /sources/web/status` 返回逐章已抓状态（`fetchedIndexes`）；
 * 3. `POST /sources/web/fetch` 续抓并累加进度；
 * 4. `GET /content?chapter=n` 对**没抓过的章**按需抓取后返回正文（本次修复的核心）；
 * 5. 参数校验与错误码。
 *
 * 抓取能力用假函数注入（`deps.fetchHtml`），因此**完全不依赖网络**，可进 CI。
 * 用法：node scripts/web-source-instance-check.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeRoutes } from '../src/http.ts';

let allPass = true;
let total = 0;
function check(name, condition, detail) {
  total += 1;
  allPass = allPass && Boolean(condition);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ---------------------------------------------------------------------------
// 合成站点：目录页 5 章 + 5 个章节页（够验证按需抓取与续抓）
// ---------------------------------------------------------------------------
const ENTRY = 'https://www.alicesw.tw/other/chapters/id/77777.html';
const CHAPTER_COUNT = 5;

function catalogHtml() {
  const items = Array.from({ length: CHAPTER_COUNT }, (_unused, index) => {
    const id = `c${String(index).padStart(3, '0')}`;
    return `<li><a href="/book/77777/${id}.html">第${index + 1}章 合成章节</a></li>`;
  }).join('');
  return `<html><head><meta charset="utf-8"></head><body>
    <div class="mu_h1"><h1>合成网页书</h1></div>
    <ul class="mulu_list">${items}</ul></body></html>`;
}

function chapterHtml(index) {
  const next = index < CHAPTER_COUNT - 1 ? `/book/77777/c${String(index + 1).padStart(3, '0')}.html` : '';
  const body = `<p>　　这是第 ${index + 1} 章的正文，用于满足最少字数阈值的合成段落，确保解析成功。</p>`.repeat(3);
  return `<html><head><meta charset="utf-8"></head><body>
    <h3 class="j_chapterName">第${index + 1}章 合成章节</h3>
    <div class="text-wrap" data-nurl="${next}"><div class="read-content">${body}</div></div>
  </body></html>`;
}

/** 记录「服务端一共收到几次抓取请求」，用于验证按需抓取只抓一次。 */
let fetchCalls = 0;
const fetchedUrls = [];
async function fakeFetchHtml(url) {
  fetchCalls += 1;
  fetchedUrls.push(url);
  if (url === ENTRY) return { html: catalogHtml(), truncated: false };
  const match = /\/c(\d{3})\.html$/.exec(url);
  if (match !== null) return { html: chapterHtml(Number(match[1])), truncated: false };
  throw new Error(`夹具缺失：${url}`);
}

// ---------------------------------------------------------------------------
// 起真实 HTTP 服务，挂上插件的路由表
// ---------------------------------------------------------------------------
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-web-instance-'));
const paths = { dir: sandbox, file: join(sandbox, 'data.json'), libraryDir: join(sandbox, 'library') };
const warnings = [];
const routes = makeRoutes({
  paths,
  logger: { warn: (error) => warnings.push(String(error)) },
  fetchHtml: fakeFetchHtml,
});

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const route = routes.find((entry) => entry.path === pathname);
  if (route === undefined) {
    res.statusCode = 404;
    res.end('no route');
    return;
  }
  void route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** 打一个 JSON 接口。 */
async function call(path, init) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const post = (path, payload) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

try {
  // ---- 1. 建书 ----
  const created = await post('/api/reading-workbench/sources/web', { url: ENTRY });
  check('POST /sources/web 返回 200', created.status === 200, `status=${created.status}`);
  check('响应包络 ok:true', created.body?.ok === true, JSON.stringify(created.body).slice(0, 120));
  const book = created.body?.data?.book;
  check('建书返回书目', book !== undefined && typeof book.id === 'string');
  check('建书时抓了首章', created.body?.data?.fetched === 1, `fetched=${created.body?.data?.fetched}`);
  check('目录总数为 5', created.body?.data?.total === CHAPTER_COUNT, `total=${created.body?.data?.total}`);

  // ---- 2. 状态：逐章已抓 ----
  const status1 = await call(`/api/reading-workbench/sources/web/status?id=${book.id}`);
  check('GET /sources/web/status 返回 200', status1.status === 200, `status=${status1.status}`);
  check('状态带 fetchedIndexes', Array.isArray(status1.body?.data?.fetchedIndexes), JSON.stringify(status1.body?.data?.fetchedIndexes));
  check('建书后已抓章序为 [0]', JSON.stringify(status1.body?.data?.fetchedIndexes) === '[0]', JSON.stringify(status1.body?.data?.fetchedIndexes));
  check('pending = 4', status1.body?.data?.pending === 4, `pending=${status1.body?.data?.pending}`);

  // ---- 3. 按需抓取：读没抓过的第 3 章（index 2）----
  const beforeOnDemand = fetchCalls;
  const content = await call(`/api/reading-workbench/content?id=${book.id}&chapter=2`);
  check('GET /content 对未抓章节返回 200（自动抓取）', content.status === 200, `status=${content.status}`);
  check(
    '返回的是该章正文 HTML',
    typeof content.body?.data?.html === 'string' && content.body.data.html.includes('第 3 章'),
    typeof content.body?.data?.html === 'string' ? `${content.body.data.html.length} 字符` : JSON.stringify(content.body).slice(0, 120),
  );
  check('按需抓取确实发生了（服务端多收 1 次抓取）', fetchCalls === beforeOnDemand + 1, `${beforeOnDemand} → ${fetchCalls}`);

  const status2 = await call(`/api/reading-workbench/sources/web/status?id=${book.id}`);
  check('按需抓取后该章进入已抓列表', JSON.stringify(status2.body?.data?.fetchedIndexes) === '[0,2]', JSON.stringify(status2.body?.data?.fetchedIndexes));

  // 再读同一章：应命中磁盘，不再触发抓取
  const beforeRepeat = fetchCalls;
  const again = await call(`/api/reading-workbench/content?id=${book.id}&chapter=2`);
  check('重复读同一章仍返回 200', again.status === 200);
  check('重复读不再抓取（走本地文件）', fetchCalls === beforeRepeat, `${beforeRepeat} → ${fetchCalls}`);

  // ---- 4. 续抓：按序补齐 ----
  const step = await post('/api/reading-workbench/sources/web/fetch', { bookId: book.id, count: 2 });
  check('POST /sources/web/fetch 返回 200', step.status === 200, `status=${step.status}`);
  check('本次抓到 2 章', step.body?.data?.fetched === 2, `fetched=${step.body?.data?.fetched}`);
  check('响应带 fetchedIndexes（供 UI 刷新标记）', Array.isArray(step.body?.data?.fetchedIndexes), JSON.stringify(step.body?.data?.fetchedIndexes));

  const status3 = await call(`/api/reading-workbench/sources/web/status?id=${book.id}`);
  const fetchedIndexes = status3.body?.data?.fetchedIndexes ?? [];
  check('已抓 4 章（0、1、2、3）', fetchedIndexes.length === 4, JSON.stringify(fetchedIndexes));
  check('剩余 1 章待抓', status3.body?.data?.pending === 1, `pending=${status3.body?.data?.pending}`);

  // 把最后一章也抓完，验证 pending 归零
  const last = await post('/api/reading-workbench/sources/web/fetch', { bookId: book.id, count: 5 });
  check('补齐最后一章', last.body?.data?.fetched === 1, `fetched=${last.body?.data?.fetched}`);
  check('全部抓完后 pending = 0', last.body?.data?.pending === 0, `pending=${last.body?.data?.pending}`);
  check('全部抓完后 catalogComplete = true', last.body?.data?.catalogComplete === true);

  // ---- 5. 参数与错误码 ----
  const badIndex = await call(`/api/reading-workbench/content?id=${book.id}&chapter=99`);
  check('章序越界返回 400', badIndex.status === 400, `status=${badIndex.status}`);
  const badUrl = await post('/api/reading-workbench/sources/web', { url: 'https://example.com/foo' });
  check('不支持的站点返回 400 + 中文原因', badUrl.status === 400 && String(badUrl.body?.error ?? '').includes('暂不支持'), JSON.stringify(badUrl.body).slice(0, 120));
  const noBook = await post('/api/reading-workbench/sources/web/fetch', { bookId: 'nope' });
  check('不存在的书目返回 400（而非 500）', noBook.status === 400, `status=${noBook.status}`);
  const statusWrong = await call('/api/reading-workbench/sources/web/status?id=nope');
  check('非网页书查状态返回 404', statusWrong.status === 404, `status=${statusWrong.status}`);

  // 上面故意打了两个非法请求（不支持的站点、不存在的书目），路由层把 4xx 原因落日志是**预期行为**；
  // 这里只要求「没有预期之外的告警」，即条数与故意触发的错误数一致。
  check(
    '只记录了那两个故意触发的 4xx 告警（无未预期告警）',
    warnings.length === 2,
    `${warnings.length} 条：${warnings.map((text) => text.slice(0, 40)).join(' / ')}`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}

console.log(`\n=== 路由级验收：${total} 项，${allPass ? '全部通过' : '存在失败'} ===`);
if (!allPass) process.exitCode = 1;
