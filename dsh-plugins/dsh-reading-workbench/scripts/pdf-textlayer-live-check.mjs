/**
 * PDF 划线链路真机验证（一次性探查，验证后保留为可复跑脚本）。
 *
 * 目的：自测用的是构造出来的文字项盒子，真机上必须确认
 * 1. 真实 PDF 页的 `getTextContent()` 能拿到文字项；
 * 2. 文字项的 `transform` / `width` 字段形状与 `pdf-geometry.ts` 的假设一致；
 * 3. 换算出的包围盒落在页面范围内（不是 NaN、不是负坐标、不是越界）。
 *
 * 用法：node scripts/pdf-textlayer-live-check.mjs [pdf 路径]
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
/** 断言。 */
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  ${detail}`}`);
  }
}

// 优先用脚本参数，其次用本机书库里那本**真实大 PDF**，最后才是自造的小样本。
// 真实书有几千个文字项、含中英混排，才是这条链路真正要面对的输入。
// 注意：书库副本在 `library/<id>/book.pdf`（PDF 走解压目录），不是 `library/<id>.pdf`。
const libraryPdf = path.join(
  os.homedir(),
  '.dsh',
  'reading-workbench',
  'library',
  'c8c8a624-ffff-4273-8ad9-eeb6363923c6',
  'book.pdf',
);
const candidates = [
  process.argv[2],
  // 用户书架上的真实书优先（存在就用它）
  existsSync(libraryPdf) ? libraryPdf : undefined,
  path.join(process.cwd(), 'scripts', 'fixtures', 'sample.pdf'),
].filter((p) => typeof p === 'string' && existsSync(p));

if (candidates.length === 0) {
  console.log('SKIP  没有可用的 PDF 样本');
  process.exit(0);
}
const pdfPath = candidates[0];
console.log(`样本：${pdfPath}`);

const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { composeTransform, itemBox } = await import('../src/client/pdf-geometry.ts');
const { buildPageText, rectsForRange } = await import('../src/client/pdf-marks.ts');

const { readFile } = await import('node:fs/promises');
const data = new Uint8Array(await readFile(pdfPath));
const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false }).promise;
check('能打开真实 PDF', doc.numPages > 0, `${doc.numPages} 页`);

/**
 * 挑一页**有文字层**的页来做验证。
 *
 * 不能固定用第 3 页：真实书的封面 / 标题页 / 插图页常常是纯图片，
 * `getTextContent()` 返回 0 项 —— 那是 PDF 本身没文字层，不是实现问题。
 * 前几个版本正是踩了这个（拿第 3 页断言「有文字项」，误判成实现失败）。
 */
let page = undefined;
let pageNo = 0;
let probeLimit = Math.min(doc.numPages, 40);
for (let n = 1; n <= probeLimit; n += 1) {
  const candidate = await doc.getPage(n);
  const content = await candidate.getTextContent();
  if (content.items.some((it) => typeof it.str === 'string' && it.str.trim() !== '')) {
    page = candidate;
    pageNo = n;
    break;
  }
}
check('在样本里找到至少一页带文字层', page !== undefined, page === undefined ? `前 ${probeLimit} 页都没有` : `第 ${pageNo} 页`);

const viewport = page.getViewport({ scale: 1.2 });
const content = await page.getTextContent();
const items = content.items;

check(`第 ${pageNo} 页能取到文字项`, Array.isArray(items) && items.length > 0, `${items?.length} 项`);

// 字段形状检查
const withStr = items.filter((it) => typeof it.str === 'string' && it.str !== '');
check('存在非空文本项', withStr.length > 0, `${withStr.length} 项非空`);
const shapeOk = withStr.every((it) => Array.isArray(it.transform) && it.transform.length >= 6 && typeof it.width === 'number');
check('文字项形状符合假设（transform≥6 且 width 是数字）', shapeOk);

// 换算到 viewport 空间
const boxes = [];
for (const raw of withStr) {
  const box = itemBox(
    { str: raw.str, transform: raw.transform, width: raw.width },
    viewport.transform,
    viewport.scale,
  );
  boxes.push(box);
}
const finite = boxes.every((b) => b.every((v) => Number.isFinite(v)));
check('所有包围盒都是有限数（无 NaN）', finite);
const inBounds = boxes.every((b) => b[0] >= -1 && b[1] >= -1 && b[2] <= viewport.width + 1 && b[3] <= viewport.height + 1);
check(
  '所有包围盒落在页面范围内（坐标换算没偏）',
  inBounds,
  inBounds ? '' : `页面 ${Math.round(viewport.width)}×${Math.round(viewport.height)}`,
);
const positiveSize = boxes.every((b) => b[2] - b[0] >= 0 && b[3] - b[1] > 0);
check('包围盒尺寸为正（高度用 hypot 得到的结果合理）', positiveSize);

// 页文本与偏移：真实场景下拼出来的文本应该包含可读内容
const pageText = buildPageText(withStr.map((raw, index) => ({ str: raw.str, box: boxes[index] })));
check('页文本非空', pageText.text.length > 0, `${pageText.text.length} 字符`);
check('偏移契约成立（每项切片等于原文）', pageText.spans.every((s) => pageText.text.slice(s.start, s.end) === s.item.str));

// 取第一个非空项做一次端到端「选区 → 偏移 → 恢复」，证明整条闭环在真实数据上成立
const first = pageText.spans[0];
if (first !== undefined) {
  const rects = rectsForRange(pageText, first.start, first.end - first.start);
  check('用真实偏移恢复出至少 1 个矩形', rects.length >= 1, `rects=${rects.length}`);
  check('恢复的矩形与原始盒子一致', JSON.stringify(rects[0]) === JSON.stringify(first.item.box));
}

console.log(`\n真实 PDF 文字层：${pageText.text.slice(0, 80).replace(/\s+/g, ' ')}…`);
console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} PASS / ${fail} FAIL`);
// 注意：legacy 构建的 PDFDocumentProxy 没有 destroy()（它在 loadingTask 上），
// 这里的进程本来就退出，只需避免抛错污染结论。
const loadingTaskDestroy = typeof doc.destroy === 'function' ? () => doc.destroy() : undefined;
if (loadingTaskDestroy !== undefined) await loadingTaskDestroy().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
