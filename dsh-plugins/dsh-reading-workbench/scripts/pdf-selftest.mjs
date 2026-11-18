/**
 * PDF 链路自测（不依赖 DSH）：手工构造最小合法 PDF，
 * 验证 二进制上传 → /file 原始字节一致 → 围栏 → 移除。
 * 用法：node scripts/pdf-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';

const dshHome = await mkdtemp(join(tmpdir(), 'rw-pdf-selftest-'));
const routes = [];
apply({
  webServer: { register(route) { routes.push(route); return () => {}; } },
  logger: { warn: () => {} },
  effect(fn) { fn(); return () => {}; },
}, { dshHome });

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
          ...(buffer === undefined ? {} : { 'content-length': buffer.length, 'content-type': extraHeaders['content-type'] ?? 'application/json' }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }));
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

// ── 构造最小合法 PDF（1 页，含 xref 与 trailer） ──
function buildPdf(text) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const pdfBytes = buildPdf('Hello PDF');
check('构造的 PDF 以 %PDF- 开头', pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-');

// ── 上传 ──
const upload = await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('测试论文')}&format=pdf`, pdfBytes, { 'content-type': 'application/octet-stream' });
const uploaded = JSON.parse(upload.buffer.toString('utf8'));
check('PDF 二进制上传', upload.status === 200 && uploaded.ok === true, `status=${upload.status} ${upload.status !== 200 ? upload.buffer.toString('utf8') : ''}`);
check('格式为 pdf', uploaded.data?.format === 'pdf');
const bookId = uploaded.data?.id;

// ── /file 原始字节一致（pdf.js 直接吃这份字节） ──
const file = await call('GET', `/api/reading-workbench/file?id=${encodeURIComponent(bookId)}`);
check('/file 返回 200', file.status === 200, `status=${file.status}`);
check('/file 字节与上传一致', Buffer.compare(file.buffer, pdfBytes) === 0, `上传 ${pdfBytes.length} / 取回 ${file.buffer.length}`);
check('/file Content-Type 为 pdf', /application\/pdf/.test(file.headers['content-type'] ?? ''), file.headers['content-type']);

// ── 书架包含该书 ──
const list = JSON.parse((await call('GET', '/api/reading-workbench/books')).buffer.toString('utf8'));
check('书架包含 PDF 书', Array.isArray(list.data) && list.data.some((entry) => entry.book.id === bookId), `共 ${list.data?.length} 本`);

// ── 路径穿越防护（/asset 对 pdf 也应拒绝越界） ──
const traversal = await call('GET', `/api/reading-workbench/asset?bookId=${encodeURIComponent(bookId)}&path=${encodeURIComponent('../../../../etc/passwd')}`);
check('/asset 路径穿越被拒', traversal.status === 400, `status=${traversal.status}`);

// ── 移除 ──
const removed = JSON.parse((await call('POST', '/api/reading-workbench/books/remove', { bookId })).buffer.toString('utf8'));
check('移除 PDF 书目', removed.ok === true && removed.data?.removed === true);

server.close();
await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\nPDF 链路自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
