/**
 * pdf.js 坐标换算（纯函数）。
 *
 * ## 为什么单独抽出来
 *
 * pdf.js 的 `textContent.items[i].transform` 是**文字空间**的仿射矩阵，
 * 不能直接当屏幕坐标用。正确做法是先与 `viewport.transform` 复合：
 *
 * ```js
 * const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
 * // tx = [a, b, c, d, e, f]
 * const x = tx[4];
 * const y = tx[5];
 * const height = Math.hypot(tx[2], tx[3]);   // 文字行高（viewport 单位）
 * const width  = item.width * viewport.scale; // 宽度按缩放放大
 * ```
 *
 * 两个容易踩的点：
 * 1. **高度要用 `hypot(tx[2], tx[3])`**，不是 `tx[3]` —— 旋转过的文字（扫描件倾斜）
 *    `tx[3]` 会失真；
 * 2. **宽度用 `item.width * scale`** —— `item.width` 是 PDF 用户空间单位，
 *    viewport 已经按 scale 缩放，不乘就会在非 100% 缩放时整体错位。
 *    这一点在 120% 默认缩放下最明显（本项目默认 scale=1.2）。
 */

/** 6 元仿射矩阵 `[a, b, c, d, e, f]`。 */
export type Matrix = [number, number, number, number, number, number];

/** 仿射矩阵复合（与 pdf.js `Util.transform` 同语义：先 m2 后 m1）。 */
export function composeTransform(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** pdf.js 文字项里本模块用到的字段。 */
export interface RawTextItem {
  str: string;
  /** 文字空间的 6 元矩阵。 */
  transform: number[];
  /** 宽度（PDF 用户空间单位）。 */
  width?: number;
  /** 高度（PDF 用户空间单位，可缺省）。 */
  height?: number;
}

/**
 * 把一个文字项换算成 viewport 空间的包围盒。
 *
 * @param item - pdf.js 的 textContent item
 * @param viewportTransform - `page.getViewport({ scale }).transform`
 * @param scale - 同一 viewport 的 scale
 * @returns `[x0, y0, x1, y1]`，其中 y0 < y1（viewport 的 y 向下，基线在下方）
 */
export function itemBox(item: RawTextItem, viewportTransform: number[], scale: number): [number, number, number, number] {
  const tx = composeTransform(
    viewportTransform as Matrix,
    (item.transform.length >= 6 ? item.transform.slice(0, 6) : [1, 0, 0, 1, 0, 0]) as Matrix,
  );
  const x = tx[4];
  const yBase = tx[5];
  // 文字高度：用 d 方向的模长；缺省时按 1 个 viewport 单位兜底，避免除零
  const height = Math.max(0.5, Math.hypot(tx[2], tx[3]));
  const width = Math.max(0, (item.width ?? 0) * scale);
  // pdf.js 的 y 是「基线」，字形在基线上方：包围盒上沿 = 基线 - 高度
  return [x, yBase - height, x + width, yBase];
}

/**
 * 把 DOM 选区矩形换算成相对 canvas 的本地坐标。
 *
 * @param rect - `Range.getClientRects()` 的一项
 * @param canvasRect - canvas 元素的 `getBoundingClientRect()`
 * @returns 相对 canvas 左上角的矩形
 *
 * 为什么要减 canvasRect：选区矩形是**视口坐标**，而文字层的 box 是 canvas 本地坐标。
 * 不减会整体偏移一个「canvas 在屏幕上的位置」，而且滚动页面后偏移量还会变 ——
 * 表现为「划线位置随滚动越错越远」。
 */
export function toLocalRect(
  rect: { left: number; top: number; right: number; bottom: number },
  canvasRect: { left: number; top: number },
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: rect.left - canvasRect.left,
    top: rect.top - canvasRect.top,
    right: rect.right - canvasRect.left,
    bottom: rect.bottom - canvasRect.top,
  };
}
