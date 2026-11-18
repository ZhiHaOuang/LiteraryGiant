/**
 * TXT 的「虚拟单元」切分（纯函数，便于单测）。
 *
 * 背景（2026-10-19 性能问题）：
 * TXT 没有章节结构，旧实现把**整本书**当成一个排版单元塞进 CSS 多栏容器，
 * 一本 55 万字的书要一次排出 400~600 列 —— 打开一本书要卡住好几秒。
 * 这里把正文切成若干单元，阅读器一次只渲染一个单元，单次排版量降到 1/N。
 *
 * 两条硬约束：
 * 1. **切点只在换行处**，不把一个字切成两半；
 * 2. **`start` 记录全书字符偏移**，且单元文本严格等于 `text.slice(start, end)` ——
 *    这样「划线锚点 = 全书偏移」的语义保持不变，旧划线无需迁移，
 *    恢复高亮时只需按单元区间换算。
 */

/** 一个虚拟单元（章）。 */
export interface TextUnit {
  /** 单元序（0 起）。 */
  index: number;
  /** 展示标题（章节标记行原文，或「第 N 节」）。 */
  title: string;
  /** 全书字符偏移（含）。 */
  start: number;
  /** 全书字符偏移（不含）。 */
  end: number;
  /** 单元正文（= text.slice(start, end)）。 */
  text: string;
}

/** 默认单元字数上限：约 2 万字，排版一次几十列，翻页手感与性能都合适。 */
export const DEFAULT_UNIT_CHARS = 20000;

/**
 * 单元最小字数：章节标记行只有攒够这么多字才切，
 * 否则一本书开头的目录/卷首标记会把正文切成一堆碎片。
 */
export const MIN_UNIT_CHARS = 2000;

/** 章节标记行（行首「第X章/回/节/卷/篇」或 Chapter N，后接不超过 40 字的标题）。 */
const HEADING = /^[ \t　]*(第[〇零一二三四五六七八九十百千两0-9]+[章回节卷篇]|Chapter\s+\d+|CHAPTER\s+\d+)[^\n]{0,40}$/;

/** 标题最长保留字符数。 */
const MAX_TITLE_CHARS = 40;

/**
 * 把文本切成虚拟单元。
 *
 * 规则（按优先级）：
 * 1. 遇到章节标记行，且当前单元已攒够 `MIN_UNIT_CHARS` → 从这里切，新单元用该行做标题；
 * 2. 当前单元已达 `maxChars` → 在下一个换行处切；
 * 3. 书很短、两条都没触发 → 只有 1 个单元（此时行为与旧实现完全一致）。
 * @param text - 全书文本。
 * @param maxChars - 单元字数上限。
 * @returns 单元数组（空文本返回空数组）。
 */
export function splitTextUnits(text: string, maxChars = DEFAULT_UNIT_CHARS): TextUnit[] {
  if (text === '') return [];
  const units: TextUnit[] = [];
  let unitStart = 0;
  /** 当前单元的标题（空串表示还没有标题，收尾时生成「第 N 节」）。 */
  let unitTitle = '';
  let lineStart = 0;
  /** 收口当前单元到 `end`。 */
  const flush = (end: number): void => {
    const index = units.length;
    units.push({
      index,
      title: unitTitle === '' ? `第 ${index + 1} 节` : unitTitle,
      start: unitStart,
      end,
      text: text.slice(unitStart, end),
    });
    unitStart = end;
    unitTitle = '';
  };

  while (lineStart < text.length) {
    const newlineAt = text.indexOf('\n', lineStart);
    const contentEnd = newlineAt === -1 ? text.length : newlineAt + 1;
    const line = text.slice(lineStart, newlineAt === -1 ? text.length : newlineAt);
    const isHeading = HEADING.test(line);
    if (isHeading) {
      const pending = lineStart - unitStart;
      if (pending === 0) {
        // 本书/本单元的第一行就是标题：直接采作标题，不切
        unitTitle = line.trim().slice(0, MAX_TITLE_CHARS);
      } else if (pending >= MIN_UNIT_CHARS) {
        flush(lineStart);
        unitTitle = line.trim().slice(0, MAX_TITLE_CHARS);
      }
    }

    // 行内超长保护：整本没有换行的 txt（网页/剪贴板来源常见）如果不在这里强制切，
    // 「只在换行处切」的约束会让它永远只有一个单元 —— 等于没优化。
    let cursor = lineStart;
    while (contentEnd - cursor > maxChars) {
      flush(cursor + maxChars);
      cursor += maxChars;
    }
    // 到行尾时若累计已超上限，就在这个换行处收口
    if (contentEnd - unitStart >= maxChars) flush(contentEnd);
    lineStart = contentEnd;
  }
  if (unitStart < text.length) flush(text.length);
  return units;
}

/**
 * 把「全书偏移区间」换算成「单元内偏移区间」。
 * 只有与单元有交集的划线才会被返回；交集外的部分截断到单元边界。
 * @param unit - 目标单元。
 * @param offset - 全书偏移。
 * @param length - 长度。
 * @returns 单元内偏移与长度；无交集返回 undefined。
 */
export function toUnitRange(
  unit: { start: number; end: number },
  offset: number,
  length: number,
): { offset: number; length: number } | undefined {
  const markEnd = offset + length;
  const from = Math.max(offset, unit.start);
  const to = Math.min(markEnd, unit.end);
  if (to <= from) return undefined;
  return { offset: from - unit.start, length: to - from };
}

/**
 * 由「全书偏移」找出它所在的单元序（用于按划线跳转到对应单元）。
 * @param units - 单元数组。
 * @param offset - 全书偏移。
 * @returns 单元序（空数组返回 0）。
 */
export function unitIndexOfOffset(units: TextUnit[], offset: number): number {
  if (units.length === 0) return 0;
  for (const unit of units) {
    if (offset < unit.end) return unit.index;
  }
  return units.length - 1;
}
