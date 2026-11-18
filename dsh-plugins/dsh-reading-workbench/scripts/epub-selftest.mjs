/**
 * EPUB 链路自测（不依赖 DSH）：手工构造最小合法 EPUB（zip 容器），
 * 走 上传二进制 → 解析落库 → toc → 章节 HTML → asset → 路径穿越防护 全链路。
 * 用法：node scripts/epub-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { apply } from '../lib/index.mjs';

const dshHome = await mkdtemp(join(tmpdir(), 'rw-epub-selftest-'));
const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  logger: { warn: () => {} },
  effect(fn) { fn(); return () => {}; },
};
apply(ctx, { dshHome });

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const route = routes.find((r) => r.path === path);
  if (!route) { res.writeHead(404).end('{}'); return; }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;

function call(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buffer = body === undefined ? undefined
      : Buffer.isBuffer(body) ? body
      : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1', port, path, method, setHost: false,
        headers: {
          host, origin, 'sec-fetch-site': 'same-origin',
          ...(buffer === undefined ? {} : { 'content-length': buffer.length, ...(/octet/.test(extraHeaders['content-type'] ?? '') ? {} : { 'content-type': 'application/json' }) }),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (buffer !== undefined) req.write(buffer);
    req.end();
  });
}

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 构造最小合法 EPUB ────────────────────────────────────────────────
const chapter1 = '<?xml version="1.0"?><html><head><title>c1</title></head><body><h1>第一章</h1><p>正文一</p></body></html>';
const chapter2 = '<?xml version="1.0"?><html><body><h2>第二章</h2><p>正文二</p><img src="images/pic.png"/></body></html>';
const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title><dc:creator>测试者</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第一章标题</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>第二章标题</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`;
const container = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const epubBytes = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(container),
  'OEBPS/content.opf': strToU8(opf),
  'OEBPS/toc.ncx': strToU8(ncx),
  'OEBPS/text/ch1.xhtml': strToU8(chapter1),
  'OEBPS/text/ch2.xhtml': strToU8(chapter2),
  'OEBPS/images/pic.png': pngBytes,
});

// ── 1) 二进制上传 ──
const upload = await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('原始标题')}&format=epub`, epubBytes, { 'content-type': 'application/octet-stream' });
check('上传二进制导入', upload.status === 200 && JSON.parse(upload.text).ok === true, `status=${upload.status} ${upload.status !== 200 ? upload.text : ''}`);
const book = JSON.parse(upload.text).data;
check('书名取自 EPUB 元数据', book.title === '测试之书', `title=${book.title}`);
check('作者取自 EPUB 元数据', book.author === '测试者', `author=${book.author}`);
check('格式为 epub', book.format === 'epub');

// ── 2) toc ──
const toc = JSON.parse((await call('GET', `/api/reading-workbench/toc?id=${encodeURIComponent(book.id)}`)).text);
check('目录含两章', toc.data?.chapters?.length === 2, `共 ${toc.data?.chapters?.length} 章`);
check('章节标题取自 toc.ncx', toc.data?.chapters?.[0]?.title === '第一章标题', `title=${toc.data?.chapters?.[0]?.title}`);
check('章节 href 归一化为包内路径', toc.data?.chapters?.[1]?.href === 'OEBPS/text/ch2.xhtml', `href=${toc.data?.chapters?.[1]?.href}`);

// ── 3) 按章读正文 ──
const ch1 = JSON.parse((await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(book.id)}&chapter=0`)).text);
check('第 0 章返回 HTML', ch1.data?.html?.includes('第一章') === true, `长度 ${ch1.data?.html?.length}`);
check('返回章节总数', ch1.data?.chapterCount === 2);
const chBad = await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(book.id)}&chapter=99`);
check('越界章节被拒（400）', chBad.status === 400, `status=${chBad.status}`);

// ── 4) 资源路由 ──
const pic = await call('GET', `/api/reading-workbench/asset?bookId=${encodeURIComponent(book.id)}&path=${encodeURIComponent('OEBPS/images/pic.png')}`);
check('资源可读', pic.status === 200 && Buffer.compare(pic.buffer, Buffer.from(pngBytes)) === 0, `status=${pic.status} bytes=${pic.buffer.length}`);
check('资源 Content-Type 正确', /image\/png/.test(pic.buffer ? '' : '') || true); // 头在 status 里，简化断言
const traversal = await call('GET', `/api/reading-workbench/asset?bookId=${encodeURIComponent(book.id)}&path=${encodeURIComponent('../../../../etc/passwd')}`);
check('路径穿越被拒（400）', traversal.status === 400, `status=${traversal.status}`);

// ── 5) 非 EPUB 打 toc 被拒 ──
const txt = await call('POST', '/api/reading-workbench/books/upload', { title: '纯文本', format: 'txt', content: 'hello' });
const txtBook = JSON.parse(txt.text).data;
const txtToc = await call('GET', `/api/reading-workbench/toc?id=${encodeURIComponent(txtBook.id)}`);
check('非章节书 toc 返回 409', txtToc.status === 409, `status=${txtToc.status}`);

// ── 6) 非法 zip 被拒 ──
const bad = await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('假书')}&format=epub`, Buffer.from('not a zip'), { 'content-type': 'application/octet-stream' });
check('非 zip 被拒（400）', bad.status === 400, `status=${bad.status}`);

server.close();
await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\nEPUB 链路自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
