/**
 * 封面链路自测（不依赖 DSH）：加载 lib 产物起临时服务，
 * 用「构造的真实 EPUB / MOBI」验证封面提取 → 落盘 → /cover 路由 → 字节一致。
 * 用临时 dshHome，不碰真实书库。
 * 用法：node scripts/cover-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { apply } from '../lib/index.mjs';

const dshHome = await mkdtemp(join(tmpdir(), 'rw-cover-selftest-'));
const routes = [];
const ctx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  logger: { warn: (error) => console.log('[warn]', error instanceof Error ? error.message : error) },
  effect(fn) {
    fn();
    return () => {};
  },
};

apply(ctx, { dshHome });

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.find((r) => r.path === path);
  if (!route) {
    res.writeHead(404).end('{}');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;

/** 发一次请求（body 可为对象 / 字节）。 */
function call(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buffer =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
            : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        setHost: false,
        headers: {
          host,
          origin,
          'sec-fetch-site': 'same-origin',
          ...(buffer === undefined
            ? {}
            : { 'content-length': buffer.length, 'content-type': extraHeaders['content-type'] ?? 'application/json' }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (buffer !== undefined) req.write(buffer);
    req.end();
  });
}

/** 解析包络。 */
function envelope(result) {
  try {
    return JSON.parse(result.text);
  } catch {
    return { ok: false, error: `非 JSON 响应（HTTP ${result.status}）` };
  }
}

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 8×8 红色 PNG（比 1×1 更接近真实封面，仍很小）。 */
const COVER_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAADUlEQVQI12P4//8/AwAI/AL+XJ/PIAAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** 内页图（用于确认「取的是封面而不是第一张图」）。 */
const INNER_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/** 带 meta cover 的 EPUB：封面与内页图不同字节，可验证选中了正确的图。 */
function makeEpubWithCover() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>有封面的书</dc:title><dc:creator>封面作者</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="inner" href="images/inner.png" media-type="image/png"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`),
    'OEBPS/toc.ncx': strToU8(`<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>唯一一章</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
</navMap></ncx>`),
    'OEBPS/images/cover.png': COVER_PNG,
    'OEBPS/images/inner.png': INNER_PNG,
    'OEBPS/text/ch1.xhtml': strToU8('<html><body><h1>正文</h1><p><img src="../images/inner.png"/></p></body></html>'),
  });
}

/** cover-image properties 形态（EPUB3，且 meta cover 缺失）。 */
function makeEpub3PropertiesCover() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB3 封面</dc:title></metadata>
  <manifest>
    <item id="cov" href="img/c.png" media-type="image/png" properties="cover-image"/>
    <item id="p1" href="img/other.png" media-type="image/png"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
    'img/c.png': COVER_PNG,
    'img/other.png': INNER_PNG,
    'ch1.xhtml': strToU8('<html><body><p>正文</p></body></html>'),
  });
}

/** 无封面 EPUB（只有内页图，且没有任何 cover 线索）。 */
function makeEpubWithoutCover() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>无封面</dc:title></metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="i1" href="images/inner.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
    'OEBPS/images/inner.png': INNER_PNG,
    'OEBPS/text/ch1.xhtml': strToU8('<html><body><p>正文</p></body></html>'),
  });
}

/** 带 EXTH 201 封面偏移的 MOBI：记录 = [record0, 正文, 图片]。 */
function makeMobiWithCover() {
  const encoder = new TextEncoder();
  const html = '<html><body><h1>MOBI 封面测试</h1><p>正文。</p></body></html>';
  const rawText = encoder.encode(html);
  const title = encoder.encode('MOBI 封面测试');

  // EXTH：100 标题 + 201 coverOffset(0)
  const rec100 = Buffer.concat([Buffer.from([0, 0, 0, 100]), Buffer.from([0, 0, 0, 8 + title.length]), title]);
  const rec201 = Buffer.concat([Buffer.from([0, 0, 0, 201]), Buffer.from([0, 0, 0, 12]), Buffer.from([0, 0, 0, 0])]);
  const body = Buffer.concat([rec100, rec201]);
  const exthRecord = Buffer.concat([
    Buffer.from('EXTH', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length + 12, 0); return b; })(),
    Buffer.from([0, 0, 0, 2]),
    body,
  ]);

  // MOBI 头：First Image Index 在 MOBI 头内偏移 92（= r0 偏移 108）指向记录 2
  const mobiHead = Buffer.alloc(96);
  mobiHead.write('MOBI', 0, 'latin1');
  mobiHead.writeUInt32BE(24, 4); // header length
  mobiHead.writeUInt32BE(2, 92); // First Image Index = 记录 2

  const record0 = Buffer.concat([
    (() => { const b = Buffer.alloc(16); b.writeUInt16BE(1, 0); b.writeUInt32BE(rawText.length, 4); b.writeUInt16BE(1, 8); b.writeUInt16BE(4096, 10); return b; })(),
    mobiHead,
    exthRecord,
  ]);
  const records = [record0, rawText, Buffer.from(COVER_PNG)];

  const pdbHead = Buffer.concat([
    Buffer.alloc(32),
    Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(12), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4),
    Buffer.from('BOOK', 'latin1'), Buffer.from('MOBI', 'latin1'), Buffer.alloc(4), Buffer.alloc(4),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(records.length, 0); return b; })(),
  ]);
  const entries = [];
  let offset = 78 + records.length * 8;
  for (const record of records) {
    const entry = Buffer.alloc(8);
    entry.writeUInt32BE(offset, 0);
    entries.push(entry);
    offset += record.length;
  }
  return Buffer.concat([pdbHead, ...entries, ...records]);
}

const cleanup = [];

// ── 1) EPUB（meta cover）─────────────────────────────────
const epubBytes = Buffer.from(makeEpubWithCover());
const epubUpload = envelope(
  await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('占位')}&format=epub`, epubBytes, {
    'content-type': 'application/octet-stream',
  }),
);
check('EPUB 导入成功', epubUpload.ok === true, epubUpload.ok ? undefined : epubUpload.error);
const epubBook = epubUpload.data;
if (epubBook) cleanup.push(epubBook.id);
check('书目标记 hasCover=true', epubBook?.hasCover === true, `hasCover=${epubBook?.hasCover}`);

const epubCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(epubBook.id)}`);
check('EPUB /cover 200', epubCover.status === 200, `status=${epubCover.status}`);
check('EPUB 封面字节 = 包内 cover.png', Buffer.compare(epubCover.buffer, Buffer.from(COVER_PNG)) === 0, `${COVER_PNG.length} vs ${epubCover.buffer.length}`);
check('未误取内页图', Buffer.compare(epubCover.buffer, Buffer.from(INNER_PNG)) !== 0, '封面与内页图字节不同');
check('封面 Content-Type 为 image/png', /image\/png/.test(String(epubCover.headers?.['content-type'])), epubCover.headers?.['content-type']);

// ── 2) EPUB3 properties="cover-image" ────────────────────
const epub3Upload = envelope(
  await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('占位3')}&format=epub`, Buffer.from(makeEpub3PropertiesCover()), {
    'content-type': 'application/octet-stream',
  }),
);
const epub3Book = epub3Upload.data;
if (epub3Book) cleanup.push(epub3Book.id);
check('EPUB3 书目标记 hasCover=true', epub3Book?.hasCover === true, `hasCover=${epub3Book?.hasCover}`);
const epub3Cover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(epub3Book.id)}`);
check('EPUB3 封面字节正确', Buffer.compare(epub3Cover.buffer, Buffer.from(COVER_PNG)) === 0, `${epub3Cover.buffer.length} 字节`);

// ── 3) 无封面 EPUB：必须明确 404（客户端据此渲染生成式封面）──
const noCoverUpload = envelope(
  await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('无封面')}&format=epub`, Buffer.from(makeEpubWithoutCover()), {
    'content-type': 'application/octet-stream',
  }),
);
const noCoverBook = noCoverUpload.data;
if (noCoverBook) cleanup.push(noCoverBook.id);
check('无封面书目 hasCover=false', noCoverBook?.hasCover === false, `hasCover=${noCoverBook?.hasCover}`);
const noCoverRes = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(noCoverBook.id)}`);
check('无封面 /cover 返回 404 而非 500', noCoverRes.status === 404, `status=${noCoverRes.status}`);
check('无封面返回 JSON 包络', envelope(noCoverRes).ok === false);

// ── 4) MOBI（EXTH 201 封面偏移）─────────────────────────
const mobiUpload = envelope(
  await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('占位mobi')}&format=mobi`, makeMobiWithCover(), {
    'content-type': 'application/octet-stream',
  }),
);
const mobiBook = mobiUpload.data;
if (mobiBook) cleanup.push(mobiBook.id);
check('MOBI 导入成功', mobiUpload.ok === true, mobiUpload.ok ? undefined : mobiUpload.error);
check('MOBI 书目标记 hasCover=true', mobiBook?.hasCover === true, `hasCover=${mobiBook?.hasCover}`);
const mobiCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(mobiBook.id)}`);
check('MOBI 封面字节 = 图片记录', Buffer.compare(mobiCover.buffer, Buffer.from(COVER_PNG)) === 0, `${COVER_PNG.length} vs ${mobiCover.buffer.length}`);

// ── 5) 文本类 / PDF 无封面 ───────────────────────────────
const textUpload = envelope(await call('POST', '/api/reading-workbench/books/upload', { title: '文本书', format: 'md', content: '# 标题\n\n正文' }));
const textBook = textUpload.data;
if (textBook) cleanup.push(textBook.id);
check('文本类 hasCover=false', textBook?.hasCover === undefined || textBook?.hasCover === false, `hasCover=${textBook?.hasCover}`);
const textCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(textBook.id)}`);
check('文本类 /cover 404', textCover.status === 404, `status=${textCover.status}`);

// ── 6) 边界 ──────────────────────────────────────────────
const unknownCover = await call('GET', '/api/reading-workbench/cover?id=does-not-exist');
check('未知书籍 /cover 404', unknownCover.status === 404, `status=${unknownCover.status}`);
const missingParam = await call('GET', '/api/reading-workbench/cover');
check('缺 id 参数 400', missingParam.status === 400, `status=${missingParam.status}`);

// ── 7) 书架接口回填老数据（hasCover 缺失）────────────────
const books = envelope(await call('GET', '/api/reading-workbench/books'));
check('书架列表带上 hasCover 字段', (books.data ?? []).every((entry) => entry.book.hasCover !== undefined), `共 ${books.data?.length} 本`);

// ── 8) 移除时清理封面缓存与书库副本 ──────────────────────
const removed = envelope(await call('POST', '/api/reading-workbench/books/remove', { bookId: epubBook.id }));
check('移除成功', removed.ok === true);
const afterRemoveCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(epubBook.id)}`);
check('移除后 /cover 404', afterRemoveCover.status === 404, `status=${afterRemoveCover.status}`);

// ── 9) 清理 ──────────────────────────────────────────────
for (const id of cleanup) {
  if (id === epubBook?.id) continue;
  await call('POST', '/api/reading-workbench/books/remove', { bookId: id });
}
const after = envelope(await call('GET', '/api/reading-workbench/books'));
check('测试数据已清理', (after.data ?? []).length === 0, `残留 ${(after.data ?? []).length} 本`);

server.close();
await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\n封面链路自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
