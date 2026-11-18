/**
 * PDF 划线定位自测（纯函数，不需要 pdf.js / 浏览器）。
 *
 * 覆盖三块，每块都带反证：
 * 1. **坐标换算**（pdf-geometry）：矩阵复合、高度用 hypot、宽度乘 scale、选区减 canvas 偏移；
 * 2. **页文本与偏移**（pdf-marks.buildPageText）：项拼接、偏移累计、空项跳过；
 * 3. **选区 → 偏移 → 矩形**闭包：多行选区、跨行、无命中、越界恢复。
 *
 * 用法：node scripts/pdf-marks-selftest.mjs
 */
import { composeTransform, itemBox, toLocalRect } from '../src/client/pdf-geometry.ts';
import { buildPageText, isItemCovered, offsetFromRects, rectsForRange } from '../src/client/pdf-marks.ts';

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

/** 浮点近似比较。 */
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

/* ═══════ 1. 坐标换算 ═══════ */

// 单位矩阵复合 = 原矩阵
const identity = [1, 0, 0, 1, 0, 0];
const m = [2, 0, 0, 2, 10, 20];
const composed = composeTransform(identity, m);
check('单位矩阵复合保持原值', composed.every((v, i) => near(v, m[i])), JSON.stringify(composed));

// 缩放 × 平移：先平移 (10,20) 再缩放 2 倍 → 位移也被放大
const scaled = composeTransform([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20]);
check('复合矩阵的平移量被缩放', near(scaled[4], 20) && near(scaled[5], 40), JSON.stringify(scaled));

// itemBox：scale=1.2，文字项在用户空间 (100, 700)，宽度 50
const viewport = { transform: [1.2, 0, 0, 1.2, 0, 0], scale: 1.2 };
const item = { str: '投资', transform: [1, 0, 0, 1, 100, 700], width: 50, height: 12 };
const box = itemBox(item, viewport.transform, viewport.scale);
check('itemBox 的 x 按 scale 缩放', near(box[0], 120), `x0=${box[0]}`);
check('itemBox 的宽度按 scale 缩放（不是原始 50）', near(box[2] - box[0], 60), `width=${box[2] - box[0]}`);
check('itemBox 的 y 是基线上方（y0 < y1）', box[1] < box[3], `[${box[1]}, ${box[3]}]`);

// 反证：不乘 scale 的宽度只有 50，会与正确值差 10px
check('反证：不乘 scale 的宽度与正确值不同', !near(50, box[2] - box[0]));

// 旋转文字：高度必须用 hypot(c, d)，不能用 d
const rotated = { str: 'x', transform: [0, 1.2, -1.2, 0, 0, 0], width: 10 };
const rotBox = itemBox(rotated, identity, 1);
check('旋转文字的高度用 hypot(c,d)', near(rotBox[3] - rotBox[1], 1.2), `h=${rotBox[3] - rotBox[1]}`);

// toLocalRect：减去 canvas 偏移
const local = toLocalRect({ left: 100, top: 200, right: 150, bottom: 220 }, { left: 40, top: 50 });
check('选区矩形减去 canvas 偏移', local.left === 60 && local.top === 150 && local.right === 110 && local.bottom === 170, JSON.stringify(local));

/* ═══════ 2. 页文本与偏移 ═══════ */

const page = buildPageText([
  { str: '第一行', box: [0, 0, 60, 12] },
  { str: '第二行', box: [0, 20, 60, 32] },
  { str: '', box: [0, 40, 10, 52] }, // 空项必须跳过
  { str: '第三行', box: [0, 40, 60, 52] },
]);
check('页文本按换行拼接', page.text === '第一行\n第二行\n第三行', JSON.stringify(page.text));
check('空项被跳过（spans 只有 3 条）', page.spans.length === 3, `spans=${page.spans.length}`);
check('第 2 项起始偏移 = 4', page.spans[1]?.start === 4, String(page.spans[1]?.start));
check('第 3 项起始偏移 = 8', page.spans[2]?.start === 8, String(page.spans[2]?.start));
check('末项结束偏移 = 全文长度', page.spans[2]?.end === page.text.length, `${page.spans[2]?.end} vs ${page.text.length}`);

// 偏移契约：每个 span 的切片必须等于原文
const sliceOk = page.spans.every((s) => page.text.slice(s.start, s.end) === s.item.str);
check('偏移契约：slice(start,end) === 原文', sliceOk);

/* ═══════ 3. 选区 → 偏移 ═══════ */

const hit = (rect) => offsetFromRects(page, [rect]);

// 选中第一行：矩形略微进入行内即可
const h1 = hit({ left: 2, top: 2, right: 58, bottom: 10 });
check('选中第一行命中', h1 !== undefined && h1.text === '第一行', JSON.stringify(h1));
check('第一行 offset=0', h1?.offset === 0, String(h1?.offset));

// 选中第二行
const h2 = hit({ left: 2, top: 22, right: 58, bottom: 30 });
check('选中第二行文本正确', h2?.text === '第二行', JSON.stringify(h2));
check('第二行 offset=4（含换行）', h2?.offset === 4, String(h2?.offset));

// 跨两行：两个矩形分别命中（这是 getClientRects 的真实形态）
const h12 = offsetFromRects(page, [
  { left: 2, top: 2, right: 58, bottom: 10 },
  { left: 2, top: 22, right: 58, bottom: 30 },
]);
check('跨行选区覆盖两行', h12?.offset === 0 && h12.length === 7, JSON.stringify(h12));
check('跨行文本含换行', h12?.text === '第一行\n第二行', JSON.stringify(h12?.text));

// 垂直重叠不足一半 → 不命中（防止把「有点擦边」的相邻行算进来）
const miss = hit({ left: 2, top: 11, right: 58, bottom: 13 });
check('垂直重叠不足一半时不命中', miss === undefined, JSON.stringify(miss));

// 完全在文字外
const outside = hit({ left: 200, top: 200, right: 240, bottom: 240 });
check('选区在文字外返回 undefined', outside === undefined);

// 水平不重叠 → 不命中
const noOverlapX = hit({ left: 100, top: 2, right: 140, bottom: 10 });
check('水平不重叠不命中', noOverlapX === undefined);

/* ═══════ 4. 偏移 → 矩形（恢复高亮） ═══════ */

const rects = rectsForRange(page, 0, 4);
check('恢复第一行得到 1 个矩形', rects.length === 1, `rects=${rects.length}`);
check('恢复的矩形与原盒一致', JSON.stringify(rects[0]) === JSON.stringify([0, 0, 60, 12]), JSON.stringify(rects[0]));

const rects12 = rectsForRange(page, 0, 7);
check('跨行恢复得到 2 个矩形', rects12.length === 2, `rects=${rects12.length}`);

// 反向一致性：选区算出的区间，恢复出的矩形必须正好覆盖被选中的那些行
const backRects = rectsForRange(page, h12.offset, h12.length);
check('选区↔恢复闭环：矩形数量一致', backRects.length === 2, `rects=${backRects.length}`);

// 越界（书改版 / 页码错乱）：不抛错，返回空
let overRan = false;
let overRects;
try {
  overRects = rectsForRange(page, 9999, 10);
} catch {
  overRan = true;
}
check('越界区间不抛错', overRan === false);
check('越界区间返回空数组', Array.isArray(overRects) && overRects.length === 0);

check('零长度区间返回空数组', rectsForRange(page, 0, 0).length === 0);

/* ═══════ 5. 判定函数的反证 ═══════ */

const sampleItem = { str: 'abc', box: [10, 10, 50, 22] };
check('正例：完全覆盖', isItemCovered(sampleItem, { left: 8, top: 8, right: 55, bottom: 24 }) === true);
check('反证：垂直只擦边不算', isItemCovered(sampleItem, { left: 8, top: 21, right: 55, bottom: 30 }) === false);
check('反证：水平不重叠不算', isItemCovered(sampleItem, { left: 60, top: 8, right: 80, bottom: 24 }) === false);
check('边界：水平恰好相切不算（严格大于 0）', isItemCovered(sampleItem, { left: 50, top: 8, right: 60, bottom: 24 }) === false);

// 整页空文字层：不能崩
const emptyPage = buildPageText([]);
check('空文字层：文本为空', emptyPage.text === '');
check('空文字层：选区返回 undefined', offsetFromRects(emptyPage, [{ left: 0, top: 0, right: 10, bottom: 10 }]) === undefined);

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
