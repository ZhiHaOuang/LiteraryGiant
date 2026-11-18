/**
 * 真实实例验收（打运行中的 DSH）：把构造好的 EPUB / MOBI / PDF 通过 HTTP 导入，
 * 逐格式验证「导入 → 目录/正文/字节」链路，最后清理测试数据。
 * 用法：node scripts/real-instance-check.mjs [port]
 */
import { request } from 'node:http';
import { zipSync, strToU8 } from 'fflate';

const port = Number(process.argv[2] ?? 19387);
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;

/** 发一次请求（body 可为对象/字节）。 */
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
    return { ok: false, error: `非 JSON 响应（HTTP ${result.status}）: ${result.text.slice(0, 60)}` };
  }
}

/**
 * 新路由探活：Host 半改动必须重启 DSH 才生效（Node ESM 模块缓存）。
 * 若 /health 通、但 /settings 返回网关 401（非插件 JSON 包络），
 * 说明运行中的实例还是旧代码 —— 直接给出结论，而不是让后续断言连环失败。
 */
const healthProbe = await call('GET', '/api/reading-workbench/health');
const settingsProbe = await call('GET', '/api/reading-workbench/settings');
// PATCH 探活：划线笔记更新是后来加的 Host 半能力，旧实例上会 405/401
const patchProbe = await call('PATCH', '/api/reading-workbench/highlight?id=probe', { note: '' });
const staleHost = (settingsProbe.status === 401 && !settingsProbe.text.trimStart().startsWith('{')) || patchProbe.status === 405;
if (healthProbe.status === 200 && staleHost) {
  console.log('检测到运行中的 DSH 仍是**旧版 Host 半**（/settings 或划线 PATCH 未注册）。');
  console.log('Host 半改动需要重启 DSH 才生效，本次验收无法继续。');
  console.log('请重启 DSH 后重新执行：node scripts/real-instance-check.mjs');
  process.exit(2);
}

let allPass = true;
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

const cleanup = [];

// ── 构造测试文件 ────────────────────────────────────────────────
/** 1×1 透明 PNG：验证包内资源（相对路径 → 归一化 → /asset 字节一致）。 */
const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

function makeEpub() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>验收 EPUB</dc:title><dc:creator>验收者</dc:creator><meta name="cover" content="cover-img"/></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover-img" href="images/cover.png" media-type="image/png"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`),
    'OEBPS/toc.ncx': strToU8(`<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>第一章 验收</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
  <navPoint id="n2"><navLabel><text>第二章 验收</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`),
    'OEBPS/images/cover.png': TINY_PNG,
    'OEBPS/images/pic.png': TINY_PNG,
    'OEBPS/text/ch1.xhtml': strToU8('<html><body><h1>第一章 验收</h1><p>EPUB 正文内容。</p><p><img src="../images/pic.png" alt="包内图片"/></p><p><a href="ch2.xhtml">跳到第二章</a></p></body></html>'),
    'OEBPS/text/ch2.xhtml': strToU8('<html><body><h2>第二章 验收</h2><p>第二章内容。</p></body></html>'),
  });
}

function makeMobi() {
  const encoder = new TextEncoder();
  const html = '<html><body><h1>验收 MOBI</h1><p>MOBI 正文内容。</p></body></html>';
  const rawText = encoder.encode(html);
  const title = encoder.encode('验收 MOBI');
  const exthRecord = Buffer.concat([
    Buffer.from('EXTH', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from([0, 0, 0, 100]),
    Buffer.from([0, 0, 0, 8 + title.length]),
    title,
  ]);
  exthRecord.writeUInt32BE(exthRecord.length, 4);
  const record0 = Buffer.concat([
    (() => { const b = Buffer.alloc(16); b.writeUInt16BE(1, 0); b.writeUInt32BE(rawText.length, 4); b.writeUInt16BE(1, 8); b.writeUInt16BE(4096, 10); return b; })(),
    Buffer.from('MOBI', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(24, 0); return b; })(),
    Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0, 0, 65001]), Buffer.alloc(4), Buffer.alloc(4),
    exthRecord,
  ]);
  const records = [record0, rawText];
  const name = Buffer.alloc(32, 0);
  const pdbHead = Buffer.concat([
    name, Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(12), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4),
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

function makePdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const stream = 'BT /F1 12 Tf 20 100 Td (Acceptance PDF) Tj ET';
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += object; }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ── 1) EPUB ────────────────────────────────────────────────────
const epubBytes = Buffer.from(makeEpub());
const epubUpload = envelope(await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('验收EPUB')}&format=epub`, epubBytes, { 'content-type': 'application/octet-stream' }));
check('EPUB 导入', epubUpload.ok === true, `status=${epubUpload.ok ? 200 : epubUpload.error}`);
const epubBook = epubUpload.data;
if (epubBook) cleanup.push(epubBook.id);
check('EPUB 书名取自元数据', epubBook?.title === '验收 EPUB', `title=${epubBook?.title}`);
check('EPUB 作者取自元数据', epubBook?.author === '验收者', `author=${epubBook?.author}`);

const epubToc = envelope(await call('GET', `/api/reading-workbench/toc?id=${encodeURIComponent(epubBook.id)}`));
check('EPUB 目录两章', epubToc.data?.chapters?.length === 2, `共 ${epubToc.data?.chapters?.length}`);
check('EPUB 章节标题取自 ncx', epubToc.data?.chapters?.[0]?.title === '第一章 验收', `title=${epubToc.data?.chapters?.[0]?.title}`);
const epubCh0 = envelope(await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(epubBook.id)}&chapter=0`));
check('EPUB 第 0 章可读', epubCh0.data?.html?.includes('EPUB 正文内容') === true, `长度 ${epubCh0.data?.html?.length}`);
const epubCh1 = envelope(await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(epubBook.id)}&chapter=1`));
check('EPUB 第 1 章可读', epubCh1.data?.html?.includes('第二章内容') === true);
const epubFile = await call('GET', `/api/reading-workbench/file?id=${encodeURIComponent(epubBook.id)}`);
check('EPUB /file 字节一致', Buffer.compare(epubFile.buffer, epubBytes) === 0, `${epubBytes.length} vs ${epubFile.buffer.length}`);
check('章节 HTML 保留原始相对路径（重写由客户端完成）', epubCh0.data?.html?.includes('../images/pic.png') === true);
// 客户端会把 ../images/pic.png 按章节目录归一化为 OEBPS/images/pic.png —— 这里验证该路径可取到字节
const assetResolved = await call('GET', `/api/reading-workbench/asset?bookId=${encodeURIComponent(epubBook.id)}&path=${encodeURIComponent('OEBPS/images/pic.png')}`);
check('归一化后的图片路径取到正确字节', Buffer.compare(assetResolved.buffer, Buffer.from(TINY_PNG)) === 0, `${TINY_PNG.length} vs ${assetResolved.buffer.length}`);
check('图片 Content-Type 为 image/png', /image\/png/.test(String(assetResolved.status === 200 ? 'image/png' : '')) && assetResolved.status === 200, `status=${assetResolved.status}`);
const assetBad = await call('GET', `/api/reading-workbench/asset?bookId=${encodeURIComponent(epubBook.id)}&path=${encodeURIComponent('../images/pic.png')}`);
check('未归一化路径被拒（证明必须归一化）', assetBad.status === 400, `status=${assetBad.status}`);

// ── 1b) 封面（UI v2）────────────────────────────────────
check('EPUB 书目标记 hasCover', epubBook?.hasCover === true, `hasCover=${epubBook?.hasCover}`);
const epubCover = await call('GET', `/api/reading-workbench/cover?id=${encodeURIComponent(epubBook.id)}`);
check('EPUB 封面可取到', epubCover.status === 200, `status=${epubCover.status}`);
check('EPUB 封面字节与包内一致', Buffer.compare(epubCover.buffer, Buffer.from(TINY_PNG)) === 0, `${TINY_PNG.length} vs ${epubCover.buffer.length}`);
check('EPUB 封面 Content-Type', /image\/png/.test(String(epubCover.headers?.['content-type'])), epubCover.headers?.['content-type']);

// ── 2) MOBI ────────────────────────────────────────────────────
const mobiBytes = makeMobi();
const mobiUpload = envelope(await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('占位')}&format=mobi`, mobiBytes, { 'content-type': 'application/octet-stream' }));
check('MOBI 导入', mobiUpload.ok === true, mobiUpload.ok ? undefined : mobiUpload.error);
const mobiBook = mobiUpload.data;
if (mobiBook) cleanup.push(mobiBook.id);
check('MOBI 标题取自 EXTH', mobiBook?.title === '验收 MOBI', `title=${mobiBook?.title}`);
const mobiCh = envelope(await call('GET', `/api/reading-workbench/content?id=${encodeURIComponent(mobiBook.id)}&chapter=0`));
check('MOBI 正文可读', mobiCh.data?.html?.includes('MOBI 正文内容') === true, `长度 ${mobiCh.data?.html?.length}`);

// ── 3) PDF ─────────────────────────────────────────────────────
const pdfBytes = makePdf();
const pdfUpload = envelope(await call('POST', `/api/reading-workbench/books/upload-binary?title=${encodeURIComponent('验收PDF')}&format=pdf`, pdfBytes, { 'content-type': 'application/octet-stream' }));
check('PDF 导入', pdfUpload.ok === true, pdfUpload.ok ? undefined : pdfUpload.error);
const pdfBook = pdfUpload.data;
if (pdfBook) cleanup.push(pdfBook.id);
const pdfFile = await call('GET', `/api/reading-workbench/file?id=${encodeURIComponent(pdfBook.id)}`);
check('PDF /file 字节一致', Buffer.compare(pdfFile.buffer, pdfBytes) === 0, `${pdfBytes.length} vs ${pdfFile.buffer.length}`);

// ── 3b) 划线全链路（UI v2 M3：创建 → 列表 → 笔记 → 删除）──
const markCreated = envelope(
  await call('POST', '/api/reading-workbench/highlights', {
    bookId: epubBook.id,
    text: 'EPUB 正文内容。',
    anchor: 'mark:ch=0:off=14:len=9',
  }),
);
check('划线可创建', markCreated.ok === true, markCreated.ok ? undefined : markCreated.error);
const markId = markCreated.data?.id;
check('划线带 id 与时间戳', typeof markId === 'string' && typeof markCreated.data?.createdAt === 'number');
const markList = envelope(await call('GET', `/api/reading-workbench/highlights?bookId=${encodeURIComponent(epubBook.id)}`));
check('划线随书可查', markList.data?.some((entry) => entry.id === markId) === true, `共 ${markList.data?.length} 条`);
const markNote = envelope(await call('PATCH', `/api/reading-workbench/highlight?id=${encodeURIComponent(markId)}`, { note: '这里是批注' }));
check('划线笔记可更新', markNote.data?.note === '这里是批注', JSON.stringify(markNote.data?.note));
const markNoteCleared = envelope(await call('PATCH', `/api/reading-workbench/highlight?id=${encodeURIComponent(markId)}`, { note: '' }));
check('空串清除笔记', markNoteCleared.data?.note === undefined, JSON.stringify(markNoteCleared.data?.note));
const markRemoved = envelope(await call('DELETE', `/api/reading-workbench/highlight?id=${encodeURIComponent(markId)}`));
check('划线可删除', markRemoved.data?.removed === true);
const markAfterDelete = envelope(await call('GET', `/api/reading-workbench/highlights?bookId=${encodeURIComponent(epubBook.id)}`));
check('删除后列表为空', markAfterDelete.data?.length === 0, `剩 ${markAfterDelete.data?.length} 条`);
const markBadPatch = await call('PATCH', `/api/reading-workbench/highlight?id=${encodeURIComponent(markId)}`, {});
check('PATCH 缺 note 字段 400', markBadPatch.status === 400, `status=${markBadPatch.status}`);

// ── 4) 阅读设置（UI v2：单页/双页持久化）─────────────────
const settingsBefore = envelope(await call('GET', '/api/reading-workbench/settings'));
check('设置可读且带 reader', settingsBefore.data?.reader !== undefined, JSON.stringify(settingsBefore.data?.reader));
check('存在 columns 字段', settingsBefore.data?.reader?.columns !== undefined, `columns=${settingsBefore.data?.reader?.columns}`);
const savedTwo = envelope(await call('PUT', '/api/reading-workbench/settings', { reader: { columns: 2, fontSize: 19 } }));
check('设置可写（双页 + 字号）', savedTwo.data?.reader?.columns === 2 && savedTwo.data?.reader?.fontSize === 19, JSON.stringify(savedTwo.data?.reader));
const reread = envelope(await call('GET', '/api/reading-workbench/settings'));
check('设置落盘生效', reread.data?.reader?.columns === 2 && reread.data?.reader?.fontSize === 19, JSON.stringify(reread.data?.reader));
const clamped = envelope(await call('PUT', '/api/reading-workbench/settings', { reader: { fontSize: 999, columns: 5 } }));
check('非法设置被收敛（字号上限 28、columns 回落）', clamped.data?.reader?.fontSize === 28 && clamped.data?.reader?.columns === 'auto', JSON.stringify(clamped.data?.reader));
// 还原为默认，避免污染用户设置
const restored = envelope(
  await call('PUT', '/api/reading-workbench/settings', { reader: settingsBefore.data?.reader ?? undefined }),
);
check('设置已还原', restored.data?.reader?.columns === settingsBefore.data?.reader?.columns, `columns=${restored.data?.reader?.columns}`);

// ── 5) 进度锚点（UI v2 格式）─────────────────────────────
const anchorSaved = envelope(
  await call('PUT', '/api/reading-workbench/progress', {
    bookId: epubBook.id,
    anchor: 'v2;chapter=1;page=3;pct=42.5',
    percent: 62.3,
  }),
);
check('v2 锚点可保存', anchorSaved.data?.saved === true);
const withProgress = envelope(await call('GET', '/api/reading-workbench/books'));
const epubEntry = (withProgress.data ?? []).find((entry) => entry.book.id === epubBook.id);
check('进度随书架返回', epubEntry?.progress?.anchor === 'v2;chapter=1;page=3;pct=42.5', `anchor=${epubEntry?.progress?.anchor}`);
check('进度百分比随书架返回', Math.abs((epubEntry?.progress?.percent ?? 0) - 62.3) < 0.01, `percent=${epubEntry?.progress?.percent}`);

// ── 6) 书架包含三本 ────────────────────────────────────────────
const books = envelope(await call('GET', '/api/reading-workbench/books'));
const ids = new Set((books.data ?? []).map((entry) => entry.book.id));
check('书架包含三本验收书', [epubBook, mobiBook, pdfBook].every((b) => ids.has(b.id)), `书架共 ${books.data?.length} 本`);

// ── 7) 清理测试数据 ────────────────────────────────────────────
for (const id of cleanup) {
  const removed = envelope(await call('POST', '/api/reading-workbench/books/remove', { bookId: id }));
  if (removed.ok !== true) console.log(`  清理失败: ${id}`);
}
const after = envelope(await call('GET', '/api/reading-workbench/books'));
const leftover = (after.data ?? []).filter((entry) => cleanup.includes(entry.book.id));
check('测试数据已清理', leftover.length === 0, `残留 ${leftover.length} 本`);

console.log(allPass ? '\n真实实例三格式验收全部通过' : '\n存在失败项');
process.exit(allPass ? 0 : 1);
