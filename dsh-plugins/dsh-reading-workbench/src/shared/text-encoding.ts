/**
 * 文本字节 → 字符串的统一解码入口（Host / Client 共用，纯函数）。
 *
 * 背景（2026-10-19 线上事故）：
 * 浏览器 `File.text()` 按规范只做 UTF-8 decode，Node 的 `readFile(path, 'utf8')`
 * 同样宽松解码。GBK 文件在这两条路径上会被逐字节解成 U+FFFD（替换符）——
 * 更糟的是导入时会把已损坏的字符串写回书库副本，损坏被**永久固化**，
 * 之后无论怎么改代码都只能重新导入。
 *
 * 因此这里立三条规矩：
 * 1. **必须拿到原始字节**再解码，不接受「调用方已经解码好的字符串」；
 * 2. 一律用**严格模式**（`fatal: true`）尝试，绝不接受宽松解码的替换符；
 * 3. 两种候选编码都严格失败时**显式抛错**，不静默降级、不塞占位符。
 *
 * 候选顺序（与 WHATWG Encoding 对齐）：
 * BOM（UTF-8 / UTF-16LE / UTF-16BE）→ UTF-8 严格 → GB18030 严格 → 抛错。
 * GB18030 是 GBK/GB2312 的超集，能覆盖中文老书的绝大多数情况。
 */

/** 支持的解码结果。 */
export interface DecodedText {
  /** 解码后的文本（BOM 已剥离）。 */
  text: string;
  /** 实际采用的编码（写入数据时便于诊断）。 */
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
  /** 是否检测到并剥离了 BOM。 */
  hadBom: boolean;
}

/** 解码失败时抛出的错误（带可操作提示，Host 侧会原样回给用户）。 */
export class TextDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextDecodeError';
  }
}

/** 认为「文本已损坏」的替换符比例阈值（宽松解码留下的 U+FFFD）。 */
export const DAMAGE_RATIO = 0.01;

/** 认为「文本已损坏」的替换符绝对数量下限（避免个别字符误报）。 */
export const DAMAGE_MIN_COUNT = 20;

/** 严格解码一个候选编码；失败返回 undefined（不抛错）。 */
function strictDecode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** 判断字节是否以给定前缀开头。 */
function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * 把字节解码成文本；失败抛 `TextDecodeError`。
 * @param bytes - 原始文件字节（不要传入已经解码过的字符串）。
 * @returns 解码结果与实际编码。
 */
export function decodeTextBytes(bytes: Uint8Array): DecodedText {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', hadBom: false };

  // 1) BOM 优先：BOM 是作者/工具明确声明的编码，不再猜测。
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const text = strictDecode(bytes.subarray(3), 'utf-8');
    if (text === undefined) throw new TextDecodeError('文件声明为 UTF-8（含 BOM），但内容不是合法 UTF-8');
    return { text, encoding: 'utf-8', hadBom: true };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    const text = strictDecode(bytes.subarray(2), 'utf-16le');
    if (text === undefined) throw new TextDecodeError('文件声明为 UTF-16LE（含 BOM），但内容不是合法 UTF-16LE');
    return { text, encoding: 'utf-16le', hadBom: true };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    const text = strictDecode(bytes.subarray(2), 'utf-16be');
    if (text === undefined) throw new TextDecodeError('文件声明为 UTF-16BE（含 BOM），但内容不是合法 UTF-16BE');
    return { text, encoding: 'utf-16be', hadBom: true };
  }

  // 2) 无 BOM：先按 UTF-8 严格解码（现代文本的绝大多数）。
  const utf8 = strictDecode(bytes, 'utf-8');
  if (utf8 !== undefined) return { text: utf8, encoding: 'utf-8', hadBom: false };

  // 3) 回退 GB18030（GBK / GB2312 的超集，中文老 txt 的常态）。
  const gb = strictDecode(bytes, 'gb18030');
  if (gb !== undefined) return { text: gb, encoding: 'gb18030', hadBom: false };

  // 4) 两种都失败：显式报错，绝不塞替换符。
  throw new TextDecodeError(
    '无法识别文本编码：既不是合法 UTF-8，也不是合法 GB18030/GBK。' +
      '请用记事本或 VS Code 另存为 UTF-8 后重新导入。',
  );
}

/**
 * 统计文本里的 U+FFFD 替换符，判断是否已被宽松解码损坏。
 *
 * 用途：打开**历史副本**时拦截事故遗留的坏数据。这类副本的原始字节已丢失，
 * 只能报错要求重新导入，不能假装正常显示。
 * @param text - 待检查文本。
 * @returns `{ count, ratio, damaged }`。
 */
export function inspectReplacementDamage(text: string): { count: number; ratio: number; damaged: boolean } {
  if (text === '') return { count: 0, ratio: 0, damaged: false };
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) count += 1;
  }
  const ratio = count / text.length;
  return { count, ratio, damaged: count >= DAMAGE_MIN_COUNT && ratio > DAMAGE_RATIO };
}
