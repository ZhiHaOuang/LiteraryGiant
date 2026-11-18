/**
 * PDF 划线的页内定位（纯函数，无 pdf.js 依赖，可被 Node 直接测试）。
 *
 * ## 为什么 PDF 划线要单独一套
 *
 * 文本类阅读器（md/txt/epub）的划线靠 DOM Range：`selectionOffsetInFlow` 把选区
 * 换算成渲染文本里的字符偏移。PDF 没有可选择的 DOM 文本 —— 页面是 canvas 画的位图。
 *
 * pdf.js 提供了**文字层**（`getTextContent()` 返回每个文本项的位置与内容），
 * 因此 PDF 划线的做法是：
 *
 * ```text
 * 用户拖选 → 拿到选区矩形的几个点（浏览器在 canvas 上也能产生 selection rect）
 *          → 用文字层的每个 item 的包围盒判断「哪些字落在选区里」
 *          → 得到页内字符偏移 [start, end) 与选中文本
 *          → 锚点记为 mark:ch=<页序号>:off=<页内偏移>:len=<长度>
 * ```
 *
 * 复用 `mark-anchor.ts` 的 `chapter` 字段装**页序号**，锚点语义不变、旧数据零迁移。
 *
 * ## 坐标约定（最容易错的一步）
 *
 * pdf.js 的 `transform` 是文字空间的 6 元组；真正可用于比较的是
 * `Util.transform(viewport.transform, item.transform)` 之后的坐标 ——
 * 即 **viewport 空间**（y 轴向下，原点在页面左上角，单位是 CSS 像素）。
 * 选区矩形（`Range.getBoundingClientRect()`）也是这个空间（相对于 canvas 元素）。
 * 两者都对上之后才能比较，否则会整体偏移。
 */

/** pdf.js 文字层里的一个文本项（只声明本模块用到的字段）。 */
export interface PdfTextItemLike {
  /** 文本内容（可能为空串，例如纯空格项）。 */
  str: string;
  /**
   * 该文本项在 **viewport 空间**的包围盒 `[x0, y0, x1, y1]`
   * （已由调用方用 `Util.transform(viewport.transform, item.transform)` 换算好）。
   */
  box: [number, number, number, number];
}

/** 一个页面的文字层：按阅读顺序拼接的文本 + 每项的累计偏移。 */
export interface PdfPageText {
  /** 整页拼接后的纯文本（项之间用换行分隔，便于人读与匹配）。 */
  text: string;
  /** 每一项在 `text` 里的起止偏移 `[start, end)`。 */
  spans: Array<{ start: number; end: number; item: PdfTextItemLike }>;
}

/**
 * 把 pdf.js 的文字项拼成页文本，并记录每项的偏移。
 *
 * 分隔规则：项之间插入 `\n`。
 * - 为什么不是空格：pdf.js 的中文文本项常常按行切分，行与行之间本该换行；
 *   插空格会让「第一行末 + 第二行首」粘成一句，划线文本读起来是错的。
 * - 代价：纯英文 PDF 里，同一行被切成多个 item 时会多出换行。
 *   这在划线文本上表现为「短句被拆行」，不违和（与 TXT 重排的已知限制同类）。
 *
 * @param items - 已换算到 viewport 空间的文本项，按 pdf.js 给出的阅读顺序
 * @returns 页文本与每项偏移
 */
export function buildPageText(items: PdfTextItemLike[]): PdfPageText {
  const chunks: string[] = [];
  const spans: PdfPageText['spans'] = [];
  let cursor = 0;
  for (const item of items) {
    if (item.str === '') continue;
    if (chunks.length > 0) {
      chunks.push('\n');
      cursor += 1;
    }
    const start = cursor;
    chunks.push(item.str);
    cursor += item.str.length;
    spans.push({ start, end: cursor, item });
  }
  return { text: chunks.join(''), spans };
}

/** 选区矩形（viewport 空间，相对 canvas 左上角）。 */
export interface SelectionRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 两个水平区间的重叠长度（无重叠返回 0）。 */
function overlapX(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** 两个垂直区间的重叠长度（无重叠返回 0）。 */
function overlapY(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * 判断一个文本项是否「被选区覆盖」。
 *
 * 判据选**行覆盖**而不是「项完全落在矩形内」：
 * 用户拖选一行时，选区矩形通常只包住字形的一部分高度（行高比字高大），
 * 要求完全包含会漏掉整行。因此以**垂直重叠超过一半**为准，
 * 水平方向只要有一点点相交就算选中（拖选到行尾时右边界常常差几个像素）。
 *
 * 这个判据是保守的：宁可多选一个字，也不要漏掉用户明确框住的行 ——
 * 漏字会让划线文本与用户在屏幕上看到的对不上，比多一个字严重得多。
 *
 * @param item - 文本项的包围盒（viewport 空间）
 * @param rect - 选区矩形
 * @returns 是否计入
 */
export function isItemCovered(item: PdfTextItemLike, rect: SelectionRectLike): boolean {
  const [x0, y0, x1, y1] = item.box;
  const height = Math.max(1e-6, y1 - y0);
  const vertical = overlapY(y0, y1, rect.top, rect.bottom);
  if (vertical / height < 0.5) return false;
  return overlapX(x0, x1, rect.left, rect.right) > 0;
}

/**
 * 由选区矩形求页内字符偏移。
 *
 * @param page - `buildPageText` 的产物
 * @param rects - 选区在各行的矩形（`Range.getClientRects()` 的每一项）
 * @returns `{ offset, length, text }`；没选中任何文字时返回 undefined
 *
 * 为什么接受**多个**矩形：跨行选区在浏览器里是一串矩形（每行一个），
 * 只取 `getBoundingClientRect()` 的外接矩形会把中间整段都框进来，
 * 在正文与页边注并排的 PDF 上会误选侧栏。
 */
export function offsetFromRects(
  page: PdfPageText,
  rects: SelectionRectLike[],
): { offset: number; length: number; text: string } | undefined {
  if (rects.length === 0 || page.spans.length === 0) return undefined;
  let first = -1;
  let last = -1;
  for (let index = 0; index < page.spans.length; index += 1) {
    const span = page.spans[index];
    if (span === undefined) continue;
    const hit = rects.some((rect) => isItemCovered(span.item, rect));
    if (!hit) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first === -1 || last === -1) return undefined;
  const startSpan = page.spans[first];
  const endSpan = page.spans[last];
  if (startSpan === undefined || endSpan === undefined) return undefined;
  const offset = startSpan.start;
  const length = endSpan.end - startSpan.start;
  if (length <= 0) return undefined;
  return { offset, length, text: page.text.slice(offset, offset + length) };
}

/**
 * 把一个 `[offset, length)` 区间映射回「要画高亮的每个矩形」。
 *
 * @param page - 页文本
 * @param offset - 页内字符偏移
 * @param length - 长度
 * @returns 每个覆盖该项的包围盒；区间与页文本不匹配（书改版）时返回空数组，**不抛错**
 *
 * 与文本流的 `applyMarks` 同一纪律：找不到就静默跳过该条，笔记栏仍能显示原文。
 */
export function rectsForRange(
  page: PdfPageText,
  offset: number,
  length: number,
): Array<[number, number, number, number]> {
  if (length <= 0) return [];
  const end = offset + length;
  const out: Array<[number, number, number, number]> = [];
  for (const span of page.spans) {
    // 与 [offset, end) 有交集即计入
    if (span.end <= offset || span.start >= end) continue;
    out.push(span.item.box);
  }
  return out;
}
