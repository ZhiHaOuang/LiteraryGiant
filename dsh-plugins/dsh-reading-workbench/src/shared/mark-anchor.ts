/**
 * 划线定位（纯函数，Host/Client 共享语义）。
 *
 * 目标：划线要能在**重排后**找回。页码/屏号会随字号与视口变化，文本不会，
 * 因此锚点记录「章节 + 划线文本 + 章内字符偏移」：
 *
 * - 章节书：`mark:ch:<chapterIndex>:off:<charOffset>:len:<length>`
 * - 文本类：`mark:off:<charOffset>:len:<length>`（全书为一个单元）
 *
 * 恢复时用 `mark:` 前缀识别；找不到（内容改版）时静默跳过该条，不报错。
 * `text` 始终随划线存库，即使定位失效，笔记栏仍能完整展示原文。
 */

/** 划线数据（与 shared/types.ts 的 Highlight 对应，这里只关心定位字段）。 */
export interface MarkAnchor {
  /** 章节序（文本类为 undefined）。 */
  chapter?: number;
  /** 单元内字符偏移（0 起）。 */
  offset: number;
  /** 划线文本长度。 */
  length: number;
}

/** 单条划线的最大文本长度（超长选区拒绝，防止把整章划成一条）。 */
export const MAX_MARK_LENGTH = 600;

/** 编码划线锚点。 */
export function encodeMarkAnchor(anchor: MarkAnchor): string {
  const parts: string[] = ['mark'];
  if (anchor.chapter !== undefined) parts.push(`ch=${Math.max(0, Math.trunc(anchor.chapter))}`);
  parts.push(`off=${Math.max(0, Math.trunc(anchor.offset))}`);
  parts.push(`len=${Math.max(0, Math.trunc(anchor.length))}`);
  return parts.join(':');
}

/**
 * 解析划线锚点；非 mark 锚点（进度/旧行号）返回 undefined。
 *
 * 注意分隔符设计：段与段之间用 `:`，段内 key/value 用 `=`。
 * 曾把 key/value 也用 `:` 连接（`mark:ch:5:off:17`），按 `:` split 后
 * key 和 value 分了家，所有字段都解析失败 —— 这里用 `=` 正是为避开该坑。
 */
export function parseMarkAnchor(raw: string | undefined): MarkAnchor | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('mark:')) return undefined;
  const fields = new Map<string, number>();
  for (const chunk of raw.split(':')) {
    const sep = chunk.indexOf('=');
    if (sep <= 0) continue;
    const key = chunk.slice(0, sep);
    const value = Number(chunk.slice(sep + 1));
    if (Number.isFinite(value) && value >= 0) fields.set(key, Math.trunc(value));
  }
  const offset = fields.get('off');
  const length = fields.get('len');
  if (offset === undefined || length === undefined) return undefined;
  const chapter = fields.get('ch');
  return { chapter, offset, length };
}

/**
 * 从纯文本里求子串偏移（恢复定位用）。
 * 空白按原样匹配：划线文本截取自 DOM 的 textContent，与这里输入的纯文本同源。
 */
export function locateText(source: string, text: string): number {
  if (text === '') return -1;
  return source.indexOf(text);
}

/** 划线是否越出单元文本范围（内容改版后可能出现）。 */
export function isStaleMark(anchor: MarkAnchor, unitLength: number): boolean {
  return anchor.offset + anchor.length > unitLength;
}

/**
 * 归一化选区文本：折叠空白并截断。
 * DOM 选区常带换行/连续空格，直接入库会让笔记栏排版很难看。
 */
export function normalizeSelectionText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_MARK_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_MARK_LENGTH - 1) + '…';
}
