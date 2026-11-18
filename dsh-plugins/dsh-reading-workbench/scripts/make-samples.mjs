/**
 * 生成三种格式的样例文件，供 GUI 手工验收直接拖进书架。
 * 用法：node scripts/make-samples.mjs
 * 产物：scripts/fixtures/sample.epub / sample.mobi / sample.pdf
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'fixtures');
await mkdir(outDir, { recursive: true });

/** 1×1 透明 PNG：验证 EPUB 包内资源（相对路径 → /asset 路由）。 */
const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/**
 * 160×240 的封面 PNG（深蓝底 + 白色横条）。
 * 手写 PNG：IHDR + IDAT(zlib) —— 只为让书架能看到真实封面，不引入图像库。
 */
function makeCoverPng() {
  const width = 160;
  const height = 240;
  // 每行：1 字节 filter(0) + width 个 RGB 像素
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      // 深蓝底 + 中间两条白色横带（书封观感）
      const band = (y > 60 && y < 68) || (y > 88 && y < 92);
      raw[pixel] = band ? 0xf5 : 0x1b;
      raw[pixel + 1] = band ? 0xf7 : 0x2f;
      raw[pixel + 2] = band ? 0xfa : 0x5a;
    }
  }
  /** CRC32（PNG 分块校验）。 */
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  /** 组装一个 PNG 分块。 */
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COVER_PNG = makeCoverPng();

/** 双章 EPUB：声明式封面（meta cover）+ toc.ncx 标题 + 相对路径图片 + 章节间链接。 */
function makeEpub() {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>样例电子书</dc:title><dc:creator>阅读工作台</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
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
  <navPoint id="n1"><navLabel><text>第一章 · 导入与阅读</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
  <navPoint id="n2"><navLabel><text>第二章 · 章节与资源</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`),
    'OEBPS/images/cover.png': COVER_PNG,
    'OEBPS/images/pic.png': TINY_PNG,
    'OEBPS/text/ch1.xhtml': strToU8(`<html><body>
<h1>第一章 · 导入与阅读</h1>
<p>这是 EPUB 样例的第一章。看到这段文字说明：解压、OPF 解析、章节懒加载与 HTML 消毒链路全部打通。</p>
<p>本样例书已经在书里声明了封面（meta name="cover"），所以书架卡片上应该能看到真实的深蓝书封，而不是生成式渐变封面。</p>
<p>下面是包内图片（相对路径 ../images/pic.png，经 /asset 路由加载）：</p>
<p><img src="../images/pic.png" alt="包内图片" width="24" height="24"/></p>
<h2>正文分页测试段落</h2>
${Array.from({ length: 24 }, (_, i) => `<p>第 ${i + 1} 段：这一段是用来把版面撑到多页的，方便验证单页 / 双页切换、左右翻页与页码计算是否正常。阅读工作台会把整章内容按多栏排版，一屏显示一到两栏。</p>`).join('\n')}
<p><a href="ch2.xhtml">点击跳到第二章（章节间链接）</a></p>
</body></html>`),
    'OEBPS/text/ch2.xhtml': strToU8(`<html><body>
<h2>第二章 · 章节与资源</h2>
<p>这是第二章。书内图片等资源会经 /asset 路由加载并做路径穿越防护。</p>
<ul><li>章节标题取自 toc.ncx</li><li>进度锚点使用 chapter 模型</li><li>翻到章末再按下一页会自动进入下一章</li></ul>
<h1>第二章的长段落</h1>
${Array.from({ length: 30 }, (_, i) => `<p>第 ${i + 1} 段：同样用来撑页，验证跨章翻页与进度恢复。</p>`).join('\n')}
<p><a href="ch1.xhtml">返回第一章</a></p>
</body></html>`),
  });
}

/** 单章 MOBI（无压缩），标题走 EXTH 100、封面走 EXTH 201 → First Image Index。 */
function makeMobi() {
  const encoder = new TextEncoder();
  const html = `<html><body>
<h1>样例 MOBI</h1>
<p>这是 MOBI 样例正文。看到这段文字说明：PDB/MOBI 头解析、PalmDOC 解压与 EXTH 元数据提取全部打通。</p>
<p>本样例带 EXTH 201 封面记录，书架卡片应显示书的封面图。</p>
${Array.from({ length: 30 }, (_, i) => `<p>第 ${i + 1} 段：用于验证 MOBI 也能分页与翻页。</p>`).join('\n')}
</body></html>`;
  const rawText = encoder.encode(html);
  const title = encoder.encode('样例 MOBI 电子书');

  // EXTH 100（标题）+ 201（coverOffset = 0，即 First Image Index 那张）
  const rec100 = Buffer.concat([Buffer.from([0, 0, 0, 100]), Buffer.from([0, 0, 0, 8 + title.length]), title]);
  const rec201 = Buffer.concat([Buffer.from([0, 0, 0, 201]), Buffer.from([0, 0, 0, 12]), Buffer.from([0, 0, 0, 0])]);
  const exthBody = Buffer.concat([rec100, rec201]);
  const exthRecord = Buffer.concat([
    Buffer.from('EXTH', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(exthBody.length + 12, 0); return b; })(),
    Buffer.from([0, 0, 0, 2]),
    exthBody,
  ]);

  // MOBI 头：First Image Index 在 MOBI 头内偏移 92（绝对 108）指向记录 2
  const mobiHead = Buffer.alloc(96);
  mobiHead.write('MOBI', 0, 'latin1');
  mobiHead.writeUInt32BE(24, 4);
  mobiHead.writeUInt32BE(2, 92);

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

/** 两页 PDF（含 xref），用于验证 canvas 渲染与页码翻页。 */
function makePdf() {
  const pageContents = [
    'BT /F1 20 Tf 50 700 Td (Reading Workbench) Tj ET BT /F1 12 Tf 50 660 Td (Page 1 - PDF sample for acceptance.) Tj ET',
    'BT /F1 16 Tf 50 700 Td (Page 2) Tj ET BT /F1 12 Tf 50 660 Td (Use the pager and zoom controls above.) Tj ET',
  ];
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${pageContents[0].length} >>\nstream\n${pageContents[0]}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `7 0 obj\n<< /Length ${pageContents[1].length} >>\nstream\n${pageContents[1]}\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

await writeFile(join(outDir, 'sample.epub'), makeEpub());
await writeFile(join(outDir, 'sample.mobi'), makeMobi());
await writeFile(join(outDir, 'sample.pdf'), makePdf());
console.log(`已生成样例：${outDir}`);
console.log('  sample.epub（两章 + 真实封面 + 包内图片 + 章节间链接 + 长正文可翻页）');
console.log('  sample.mobi（单章 + EXTH 封面 + 长正文可翻页）');
console.log('  sample.pdf（两页，可翻页与缩放）');
