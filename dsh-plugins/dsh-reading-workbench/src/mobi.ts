/**
 * MOBI 解析（v1：经典 MOBI / PalmDOC）。
 * 结构：PDB 头（78 字节，含记录数与记录偏移表）→ record0（PalmDOC/MOBI 头）→
 * 正文 records（PalmDOC 压缩或无压缩）→ 拼接为整本 HTML。
 *
 * v1 边界（如实标注）：
 * - 只支持无压缩（1）与 PalmDOC 压缩（2）；HUFF/CDIC（17480，AZW3/KF8 常用）不支持；
 * - 图片记录不提取，产物是正文纯 HTML（trailing bytes 尾部字段剥离）；
 * - EXTH 元数据里取标题（失败回落 PDB name）。
 */

/** PalmDOC LZ77 解压。 */
export function palmdocDecompress(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;
  while (i < input.length) {
    const byte = input[i]!;
    i += 1;
    if (byte === 0) {
      output.push(0);
    } else if (byte <= 8) {
      // 字面量对：1-8 后跟对应数量的原始字节
      for (let n = 0; n < byte && i < input.length; n += 1) {
        output.push(input[i]!);
        i += 1;
      }
    } else if (byte <= 0x7f) {
      output.push(byte);
    } else if (byte <= 0xbf) {
      // 两字符 LZ77：10xxxxxx xxxxxxxx —— 先剥掉标志位再算距离
      const pair = ((byte & 0x3f) << 8) | (input[i] ?? 0);
      i += 1;
      const distance = pair >> 3;
      if (distance !== 0) {
        let length = (pair & 7) + 3;
        while (length > 0) {
          const source = output.length - distance;
          if (source < 0) break;
          output.push(output[source]!);
          length -= 1;
        }
      } else {
        output.push(0x20); // 距离 0 表示空格
      }
    } else {
      // 空格 + 字符：1xxxxxxx → 空格 + (byte & 0x7f)
      output.push(0x20, byte & 0x7f);
    }
  }
  return Uint8Array.from(output);
}

/** 读大端 Uint16/Uint32。 */
function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
}
function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/** 解析结果。 */
export interface MobiBook {
  title: string;
  html: string;
}

/** 解析 MOBI 字节流为整本 HTML。 */
export function parseMobi(bytes: Uint8Array): MobiBook {
  // ── PDB 头 ──
  if (bytes.length < 78) throw new Error('文件太小，不是 MOBI');
  const type = String.fromCharCode(bytes[60] ?? 0, bytes[61] ?? 0, bytes[62] ?? 0, bytes[63] ?? 0);
  if (type !== 'BOOK' && type !== 'TEXt') {
    throw new Error(`不是 MOBI/PalmDOC 文件（PDB type=${type}）`);
  }
  const recordCount = u16(bytes, 76);
  if (recordCount < 2) throw new Error('MOBI 记录数异常');
  // 记录偏移表从 78 开始，每项 8 字节（offset 4 + 属性 4）
  const recordOffset = (index: number): number => u32(bytes, 78 + index * 8);

  // ── record0：PalmDOC 头（16 字节）+ MOBI 头 ──
  const r0 = bytes.subarray(recordOffset(0), recordOffset(1));
  const compression = u16(r0, 0);
  const textLength = u32(r0, 4);
  const recordCountText = u16(r0, 8);
  if (compression === 17480) {
    throw new Error('该 MOBI 使用 HUFF/CDIC 压缩（AZW3/KF8），当前版本不支持，请转换为标准 MOBI');
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error(`不支持的压缩类型：${compression}`);
  }

  // MOBI 头（可选）：'MOBI' 魔数在 PalmDOC 头之后
  let title = '';
  const mobiMagic = String.fromCharCode(r0[16] ?? 0, r0[17] ?? 0, r0[18] ?? 0, r0[19] ?? 0);
  if (mobiMagic === 'MOBI') {
    const headerLength = u32(r0, 20);
    // EXTH 在 MOBI 头内（offset 0x10 + headerLength 起，'EXTH' 魔数）
    const exthStart = 16 + headerLength;
    if (exthStart + 12 <= r0.length && String.fromCharCode(r0[exthStart] ?? 0, r0[exthStart + 1] ?? 0, r0[exthStart + 2] ?? 0, r0[exthStart + 3] ?? 0) === 'EXTH') {
      const exthCount = u32(r0, exthStart + 8);
      let p = exthStart + 12;
      for (let n = 0; n < exthCount && p + 8 <= r0.length; n += 1) {
        const recType = u32(r0, p);
        const recLen = u32(r0, p + 4);
        if (recLen < 8 || p + recLen > r0.length) break;
        if (recType === 100) {
          // EXTH 100 = updated title（UTF-8）
          title = new TextDecoder('utf-8').decode(r0.subarray(p + 8, p + recLen));
        }
        p += recLen;
      }
    }
  }
  if (title === '') {
    // 回落 PDB name（偏移 0，最长 32 字节，null 截断）
    const nameBytes = bytes.subarray(0, 32);
    const end = nameBytes.findIndex((b) => b === 0);
    title = new TextDecoder('latin1').decode(end === -1 ? nameBytes : nameBytes.subarray(0, end));
  }

  // ── 正文 records：1..recordCountText ──
  // 最后一条正文的终点是文件结尾（trailing bytes 在 v1 不剥离——textLength 截断保证正确性）
  const parts: Uint8Array[] = [];
  for (let index = 1; index <= recordCountText && index < recordCount; index += 1) {
    const start = recordOffset(index);
    const end = index + 1 < recordCount ? recordOffset(index + 1) : bytes.length;
    if (end <= start || end > bytes.length) break;
    const raw = bytes.subarray(start, end);
    parts.push(compression === 2 ? palmdocDecompress(raw) : raw);
  }
  const joined = parts.reduce((total, part) => total + part.length, 0);
  const full = new Uint8Array(joined);
  let cursor = 0;
  for (const part of parts) {
    full.set(part, cursor);
    cursor += part.length;
  }
  if (full.length < textLength) {
    throw new Error(`MOBI 正文不完整：期望 ${textLength} 字节，实得 ${full.length}`);
  }

  // PalmDOC 正文是 HTML 字节流（一般 cp1252 或 UTF-8；v1 先 UTF-8，失败回落 latin1）
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let html = decoder.decode(full.subarray(0, textLength));
  if (html.includes('\uFFFD')) {
    html = new TextDecoder('latin1').decode(full.subarray(0, textLength));
  }
  return { title, html };
}
