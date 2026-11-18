/**
 * 分页计算（纯函数，无 DOM 依赖，便于单测）。
 *
 * 渲染策略：正文容器用 CSS 多栏（`column-fill: auto` + 固定高度）把整章内容
 * 排成 N 列，视口只露出一列（单页）或两列（双页），翻页就是横向平移一屏。
 * 这样「页码」是真实排版结果，改字号/改窗口会自动重排并重算页数。
 *
 * 本模块只做算术：列数 → 屏数、屏号 → 位移、进度 ↔ 屏号换算。
 */
import type { ReaderColumns } from '../shared/types.ts';

/** 每列最小可读宽度（px）：低于此宽度不再并排两列。 */
export const MIN_COLUMN_WIDTH = 380;

/** 列间距（px）。 */
export const COLUMN_GAP = 48;

/** 阅读区左右内边距（px，与 CSS 保持一致）。 */
export const VIEWPORT_PADDING = 32;

/** 分页结果。 */
export interface Pagination {
  /** 单列宽度（px）。 */
  columnWidth: number;
  /** 列间距（px）。 */
  gap: number;
  /** 一屏可见列数（1 或 2）。 */
  columnsPerView: 1 | 2;
  /** 排版出的总列数（至少 1）。 */
  columnCount: number;
  /** 总屏数。 */
  viewCount: number;
}

/** 按设置与视口宽度决定实际栏数（`auto` = 宽屏双页）。 */
export function resolveColumns(setting: ReaderColumns, viewportWidth: number): 1 | 2 {
  if (setting === 1 || setting === 2) return setting;
  // 双页要求每列都达到最小可读宽度
  const needed = MIN_COLUMN_WIDTH * 2 + COLUMN_GAP + VIEWPORT_PADDING * 2;
  return viewportWidth >= needed ? 2 : 1;
}

/** 单列宽度：视口内容宽度减去列间距后按栏数均分。 */
export function columnWidthOf(viewportWidth: number, columnsPerView: 1 | 2): number {
  const available = Math.max(120, viewportWidth - VIEWPORT_PADDING * 2);
  if (columnsPerView === 1) return available;
  return Math.max(120, (available - COLUMN_GAP) / 2);
}

/**
 * 一屏可见宽度（= 多栏容器的宽度）：可见列宽之和 + 列之间那 `cols-1` 个间距。
 *
 * ⚠️ 这个值**不是**翻页步长：一屏的右边界落在最后一列的右边缘，而下一屏的
 * 第一列要从「最后一列右边缘 + 一个列间距」处开始。两者相差 `COLUMN_GAP`。
 * 混用会导致每翻一屏累积偏差一个列间距（实测症状：左侧露白、右侧文字被切）。
 */
export function screenWidthOf(columnWidth: number, columnsPerView: 1 | 2): number {
  return columnWidth * columnsPerView + COLUMN_GAP * (columnsPerView - 1);
}

/** 翻一屏的位移量：可见列数 × 列步进（列宽 + 间距）。 */
export function stepOf(columnWidth: number, columnsPerView: 1 | 2): number {
  return columnsPerView * (columnWidth + COLUMN_GAP);
}

/** 由排版宽度推算列数（scrollWidth → 列数）。 */
export function columnCountOf(scrollWidth: number, columnWidth: number, gap: number): number {
  if (columnWidth <= 0) return 1;
  const raw = (scrollWidth + gap) / (columnWidth + gap);
  return Math.max(1, Math.round(raw));
}

/** 组装分页信息。 */
export function makePagination(
  viewportWidth: number,
  scrollWidth: number,
  columnsPerView: 1 | 2,
): Pagination {
  const gap = COLUMN_GAP;
  const columnWidth = columnWidthOf(viewportWidth, columnsPerView);
  const columnCount = columnCountOf(scrollWidth, columnWidth, gap);
  return {
    columnWidth,
    gap,
    columnsPerView,
    columnCount,
    viewCount: viewCountOf(columnCount, columnsPerView),
  };
}

/** 总屏数：列数按一屏可见列数分组，向上取整。 */
export function viewCountOf(columnCount: number, columnsPerView: 1 | 2): number {
  return Math.max(1, Math.ceil(Math.max(1, columnCount) / columnsPerView));
}

/**
 * 某屏对应的横向位移（px，用于 translateX 负值）。
 *
 * 用 `stepOf`（列步进）而不是 `screenWidthOf`（一屏可见宽度）：
 * 一屏可见区比「跨到下一屏」少一个列间距，用错就会累积偏移。
 */
export function viewOffset(view: number, pagination: Pagination): number {
  const clamped = clampView(view, pagination.viewCount);
  return clamped * stepOf(pagination.columnWidth, pagination.columnsPerView);
}

/** 屏号收敛到合法范围。 */
export function clampView(view: number, viewCount: number): number {
  if (!Number.isFinite(view)) return 0;
  return Math.min(Math.max(0, Math.trunc(view)), Math.max(0, viewCount - 1));
}

/** 屏号 → 单元内百分比（0-100）。 */
export function percentOfView(view: number, viewCount: number): number {
  if (viewCount <= 1) return 100;
  return Math.min(100, Math.max(0, (clampView(view, viewCount) / (viewCount - 1)) * 100));
}

/**
 * 百分比 → 屏号（用于恢复进度）。
 * 百分比定位在换视口后仍有意义：页码会因重排失效，比例不会。
 */
export function viewOfPercent(percent: number, viewCount: number): number {
  if (viewCount <= 1) return 0;
  const ratio = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) / 100;
  return clampView(Math.round(ratio * (viewCount - 1)), viewCount);
}

/**
 * 恢复屏号：优先采用锚点页码（同一视口下精确），
 * 页数变化时按百分比换算，两者都不合理时回到首页。
 */
export function restoreView(anchorPage: number, anchorPercent: number, viewCount: number): number {
  if (viewCount <= 0) return 0;
  if (anchorPage >= 0 && anchorPage < viewCount) return anchorPage;
  return viewOfPercent(anchorPercent, viewCount);
}
