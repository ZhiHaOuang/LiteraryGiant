/**
 * 阅读定位锚点（Host / Client 共享的纯函数）。
 *
 * 设计取舍：页码依赖视口尺寸与字号，换设备就失效；百分比跨视口稳定但精度低。
 * 因此锚点同时记录两者，恢复时**优先用页码、页码越界时回落百分比**：
 *
 * - 章节书（epub/mobi）：`v2;chapter=3;page=2;pct=41.5` —— chapter 是章节序（0 起），
 *   page/pct 是**章内**位置；
 * - 文本类（md/txt/html）：`v2;page=7;pct=58.2` —— 全书页码；
 * - PDF：`v2;page=12;pct=57.1` —— 页码直接来自 PDF 页数，跨视口依然准确。
 *
 * 兼容旧数据：历史锚点为 `line:12` / `chapter:5` / `page:7`（1 起），
 * 解析时降级为「页 0 + 对应单元」，不抛错。
 */

/** 阅读锚点。 */
export interface ReadingAnchor {
  /** 章节序（0 起；仅章节书有）。 */
  chapter?: number;
  /** 当前单元内页码（0 起）。 */
  page: number;
  /** 当前单元内百分比（0-100）。 */
  pct: number;
}

/** 版本前缀：新增字段时改版本号，便于解析分支。 */
const PREFIX = 'v2';

/** 序列化锚点。 */
export function encodeAnchor(anchor: ReadingAnchor): string {
  const parts: string[] = [PREFIX];
  if (anchor.chapter !== undefined) parts.push(`chapter=${Math.max(0, Math.trunc(anchor.chapter))}`);
  parts.push(`page=${Math.max(0, Math.trunc(anchor.page))}`);
  parts.push(`pct=${clampPercent(anchor.pct).toFixed(1)}`);
  return parts.join(';');
}

/** 百分比收敛到 0-100，非有限值归零。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 解析锚点；无法识别时返回 undefined（调用方按「从头开始」处理）。 */
export function parseAnchor(raw: string | undefined): ReadingAnchor | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = raw.trim();

  if (value.startsWith(PREFIX + ';')) {
    const fields = new Map<string, string>();
    for (const chunk of value.slice(PREFIX.length + 1).split(';')) {
      const eq = chunk.indexOf('=');
      if (eq <= 0) continue;
      fields.set(chunk.slice(0, eq), chunk.slice(eq + 1));
    }
    const page = Number(fields.get('page'));
    const pct = Number(fields.get('pct'));
    const chapterRaw = fields.get('chapter');
    const anchor: ReadingAnchor = {
      page: Number.isFinite(page) && page >= 0 ? Math.trunc(page) : 0,
      pct: clampPercent(pct),
    };
    if (chapterRaw !== undefined) {
      const chapter = Number(chapterRaw);
      if (Number.isFinite(chapter) && chapter >= 0) anchor.chapter = Math.trunc(chapter);
    }
    return anchor;
  }

  // ── 旧锚点兼容 ──
  const legacyChapter = /^chapter:(\d+)/.exec(value);
  if (legacyChapter !== null) {
    return { chapter: Number(legacyChapter[1]), page: 0, pct: 0 };
  }
  const legacyPage = /^page:(\d+)/.exec(value);
  if (legacyPage !== null) {
    // 旧 PDF 锚点是 1 起的页码
    return { page: Math.max(0, Number(legacyPage[1]) - 1), pct: 0 };
  }
  if (/^line:\d+/.test(value)) {
    // 行号无法映射到页码（旧模型无分页），从头开始
    return { page: 0, pct: 0 };
  }
  return undefined;
}

/**
 * 全书百分比。
 * @param anchor 锚点
 * @param unitCount 单元总数（章节数或总页数），<= 1 时直接用锚点自身百分比
 */
export function overallPercent(anchor: ReadingAnchor, unitCount: number): number {
  if (unitCount <= 1) return clampPercent(anchor.pct);
  const unit = anchor.chapter ?? 0;
  const within = clampPercent(anchor.pct) / 100;
  return clampPercent(((unit + within) / unitCount) * 100);
}

/**
 * 恢复页码：页码在同一视口下有效则直接用；越界（换设备/换字号导致页数变化）
 * 时按百分比换算。
 *
 * 注意：这里是**页码 → 页序**的通用换算，实际的屏号恢复请用
 * `client/paginate.ts` 的 `restoreView`（那边还负责多栏排版下的屏号收敛）。
 */
export function restorePage(anchor: ReadingAnchor, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (anchor.pct <= 0 && anchor.page < pageCount) return anchor.page;
  // 与 paginate.viewOfPercent 保持同一套刻度：N 页时百分比映射到 0..N-1
  const fromPercent = Math.round((clampPercent(anchor.pct) / 100) * Math.max(0, pageCount - 1));
  if (anchor.page < pageCount && fromPercent === anchor.page) return anchor.page;
  return Math.min(pageCount - 1, Math.max(0, fromPercent));
}

/** 单元内百分比（页序 → 0-100）。 */
export function pagePercent(page: number, pageCount: number): number {
  if (pageCount <= 1) return 100;
  return clampPercent((page / (pageCount - 1)) * 100);
}
