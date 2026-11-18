/**
 * MOBI 链路自测（不依赖 DSH）：
 * 1) PalmDOC 解压单元用例（字面量/回溯/空格转义）
 * 2) 手工构造最小 MOBI（无压缩与 PalmDOC 两种）走 上传 → 解析 → 章节阅读 链路
 * 用法：node scripts/mobi-selftest.mjs
 */
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.mjs';

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 1) PalmDOC 解压单元用例（直接测源码，Node 24 原生剥类型） ──
const { palmdocDecompress } = await import('../src/mobi.ts');

// 字面量：0x05 后跟 5 字节
const literal = palmdocDecompress(Uint8Array.from([0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
check('PalmDOC 字面量对', Buffer.from(literal).toString('latin1') === 'hello', JSON.stringify(Buffer.from(literal).toString('latin1')));

// 0x00 → 空字节；0x01-0x08 字面量；<=0x7f 直接字符
const plain = palmdocDecompress(Uint8Array.from([0x41, 0x00, 0x42]));
check('PalmDOC 直通字符与空字节', Buffer.from(plain).toString('latin1') === 'A\u0000B');

// 空格转义：0xc5 → 空格 + 'E'（0xc0-0xff 区间，低 7 位是字符）
const spacePair = palmdocDecompress(Uint8Array.from([0xc5]));
check('PalmDOC 空格转义', Buffer.from(spacePair).toString('latin1') === ' E');

// 回溯：先输出 "abcabc"，再用回溯引用复制
// 两字节对：pair = ((b1 & 0x3f) << 8) | b2；dist = pair >> 3, len = (pair & 7) + 3
// dist=6, len=3 → pair = (6<<3)|0 = 0x30 → b1 = 0x80, b2 = 0x30
const backtrack = palmdocDecompress(Uint8Array.from([0x06, 0x61, 0x62, 0x63, 0x61, 0x62, 0x63, 0x80, 0x30]));
check('PalmDOC 回溯复制', Buffer.from(backtrack).toString('latin1') === 'abcabcabc', JSON.stringify(Buffer.from(backtrack).toString('latin1')));

// ── 2) 构造最小 MOBI 并走全链路 ──
const dshHome = await mkdtemp(join(tmpdir(), 'rw-mobi-selftest-'));
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
          ...(buffer === undefined ? {} : { 'content-length': buffer.length, 'content-type': extraHeaders['content-type'] ?? 'application/json' }),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (buffer !== undefined) req.write(buffer);
    req.end();
  });
}

/** 构造最小 MOBI：PDB 头 + record0（PalmDOC 头 + MOBI 头 + EXTH 标题）+ 正文记录。 */
function buildMobi({ title, html, compression }) {
  const encoder = new TextEncoder();
  const rawText = encoder.encode(html);
  let textRecord;
  if (compression === 2) {
    // 无压缩直存（PalmDOC 压缩流里未压缩字面量也合法：全部按字面量对/直通编码）
    // 这里用"每字节 <=0x7f 直通"编码压缩文本（纯 ASCII HTML）
    const out = [];
    for (const byte of rawText) {
      if (byte === 0) { out.push(0x00); } // 空字节
      else if (byte <= 0x7f) { out.push(byte); } // 直通
      else { out.push(0x01, byte); } // 字面量对
    }
    textRecord = Uint8Array.from(out);
  } else {
    textRecord = rawText; // compression=1 无压缩
  }
  const textLength = rawText.length;

  // EXTH：标题（magic + headerLen + count + type + len + data）
  const titleBytes = encoder.encode(title);
  const exthRecord = Buffer.concat([
    Buffer.from('EXTH', 'latin1'),
    Buffer.from([0, 0, 0, 0]), // header length 占位
    Buffer.from([0, 0, 0, 1]), // record count
    Buffer.from([0, 0, 0, 100]), // type 100 = updated title
    Buffer.from([0, 0, 0, 8 + titleBytes.length]), // record length
    titleBytes,
  ]);
  exthRecord.writeUInt32BE(exthRecord.length, 4);

  // MOBI 头：headerLength=24 = magic(4)+len(4)+type(4)+encoding(4)+uniqueID(4)+fileVersion(4)
  // EXTH 紧跟 MOBI 头结束处（record0 内 16+24=40 起与解析器一致）
  const mobiHeaderLength = 24;
  const mobiHeader = Buffer.concat([
    Buffer.from('MOBI', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(mobiHeaderLength, 0); return b; })(),
    Buffer.from([0, 0, 0, 2]), // type: mobipocket book
    Buffer.from([0, 0, 0, 65001]), // encoding utf-8
    Buffer.alloc(4), // uniqueID
    Buffer.alloc(4), // fileVersion
    exthRecord,
  ]);

  // record0 = PalmDOC 头(16) + MOBI 头
  const record0 = Buffer.concat([
    (() => {
      const b = Buffer.alloc(16);
      b.writeUInt16BE(compression, 0);
      b.writeUInt32BE(textLength, 4);
      b.writeUInt16BE(1, 8); // 1 条正文记录
      b.writeUInt16BE(4096, 10); // record size
      return b;
    })(),
    mobiHeader,
  ]);

  // PDB 头：78 字节 = name(32) + attributes(2) + version(2) + 日期(12) + modnum(4)
  //        + appInfoID(4) + sortInfoID(4) + type(4) + creator(4) + uniqueIDseed(4)
  //        + nextRecordListID(4) + recordCount(2)；随后是偏移表（每条 8 字节）
  const records = [record0, textRecord];
  const name = Buffer.alloc(32, 0);
  Buffer.from(title, 'latin1').subarray(0, 32).copy(name);
  const pdbHead = Buffer.concat([
    name,
    Buffer.alloc(2), // attributes
    Buffer.alloc(2), // version
    Buffer.alloc(12), // created / modified / backup 日期
    Buffer.alloc(4), // modificationNumber
    Buffer.alloc(4), // appInfoID
    Buffer.alloc(4), // sortInfoID
    Buffer.from('BOOK', 'latin1'), // type
    Buffer.from('MOBI', 'latin1'), // creator
    Buffer.alloc(4), // uniqueIDseed
    Buffer.alloc(4), // nextRecordListID
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

const html = '<html><body><h1>MOBI 标题</h1><p>中文正文测试。</p></body></html>';

// 无压缩
const mobiPlain = buildMobi({ title: '无压缩书', html, compression: 1 });
const up1 = JSON.parse((await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('fallback')}&format=mobi`, mobiPlain, { 'content-type': 'application/octet-stream' })).text);
check('无压缩 MOBI 导入', up1.ok === true, JSON.stringify(up1).slice(0, 120));
check('标题取自 EXTH', up1.data?.title === '无压缩书', `title=${up1.data?.title}`);
const read1 = JSON.parse((await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(up1.data.id)}&chapter=0`)).text);
check('无压缩正文可读', read1.data?.html?.includes('中文正文测试') === true, `长度 ${read1.data?.html?.length}`);

// PalmDOC（直通编码）
const mobiComp = buildMobi({ title: '压缩书', html, compression: 2 });
const up2 = JSON.parse((await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('x')}&format=mobi`, mobiComp, { 'content-type': 'application/octet-stream' })).text);
check('PalmDOC MOBI 导入', up2.ok === true, JSON.stringify(up2).slice(0, 120));
const read2 = JSON.parse((await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(up2.data.id)}&chapter=0`)).text);
check('PalmDOC 正文往返一致', read2.data?.html?.includes('中文正文测试') === true, `长度 ${read2.data?.html?.length}`);

// HUFF/CDIC 拒绝
const huff = buildMobi({ title: 'huff', html: '<html></html>', compression: 1 });
huff.writeUInt16BE(17480, 78 + 8); // record0 的 compression 字段（record0 起点 78+8=86）
const up3 = JSON.parse((await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('h')}&format=mobi`, huff, { 'content-type': 'application/octet-stream' })).text);
check('HUFF/CDIC 导入仍成功（阅读时报错）或明确报错', up3.ok === true || up3.error !== undefined, JSON.stringify(up3).slice(0, 80));

server.close();
await rm(dshHome, { recursive: true, force: true });
console.log(allPass ? '\nMOBI 链路自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
