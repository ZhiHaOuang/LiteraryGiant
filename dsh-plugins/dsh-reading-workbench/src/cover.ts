/**
 * 封面提取：EPUB 走 OPF 的 cover 元数据 / cover-image 属性，
 * MOBI 走 EXTH 201/202 + MOBI 头的 First Image Index。
 *
 * 产物缓存在 library/<bookId>/：`cover.<ext>` 图片本体 + `cover.json` 索引
 * （`{ file }` 表示有封面；`{ none: true }` 表示确认无封面，避免每次请求重复解压）。
 * md/txt/html/pdf 没有可提取的封面，由客户端生成式封面兜底。
 */
import { unzipSync, strFromU8 } from 'fflate';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Book, BookFormat, StorePathsLike } from './shared/types.ts';
import { locateOpf, readTags, resolvePackagePath } from './epub.ts';

/** 提取到的封面字节 + 扩展名。 */
export interface CoverBytes {
  bytes: Uint8Array;
  /** 图片扩展名（jpg / png / gif / webp / bmp）。 */
  ext: string;
}

/** 图片魔数表（顺序即优先级）。 */
const MAGIC: Array<{ ext: string; test: (bytes: Uint8Array) => boolean }> = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', test: (b) => String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0) === 'GIF' },
  {
    ext: 'webp',
    test: (b) =>
      String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0) === 'RIFF' &&
      String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0) === 'WEBP',
  },
  { ext: 'bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

/** 探测图片扩展名（前缀魔数）。 */
export function sniffImageExt(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  return MAGIC.find((entry) => entry.test(bytes))?.ext;
}

/** 文件头若不在 0 偏移，向后搜索一小段（部分 MOBI 图片记录带前导字节）。 */
function sniffImageExtDeep(bytes: Uint8Array, window = 64): string | undefined {
  const direct = sniffImageExt(bytes);
  if (direct !== undefined) return direct;
  for (let offset = 1; offset < Math.min(window, bytes.length - 4); offset += 1) {
    const found = sniffImageExt(bytes.subarray(offset));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 去掉前导偏移（魔数不在 0 时截断到魔数处）。 */
function trimToMagic(bytes: Uint8Array): Uint8Array {
  if (sniffImageExt(bytes) !== undefined) return bytes;
  for (let offset = 1; offset < Math.min(64, bytes.length - 4); offset += 1) {
    if (sniffImageExt(bytes.subarray(offset)) !== undefined) return bytes.subarray(offset);
  }
  return bytes;
}

/**
 * EPUB 封面：只认**书里声明的**封面信号，不猜。
 *
 * 候选顺序（依次尝试，取第一个能解出图片字节的）：
 * 1. `<meta name="cover" content="id">` 指向的 manifest 项（EPUB2 主流做法）；
 * 2. `properties="cover-image"`（EPUB3 标准）；
 * 3. id 或 href 里含 "cover" 的图片项（部分转换工具只留文件名线索）。
 *
 * 明确**不做**「取 manifest 里第一张图」这种猜测：那样会把书里的插图/示意图
 * 当成封面，比没有封面更糟。无封面时返回 undefined，由客户端渲染生成式封面。
 */
export function extractEpubCover(bytes: Uint8Array): CoverBytes | undefined {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return undefined;
  }
  let opfPath: string;
  try {
    opfPath = locateOpf(files);
  } catch {
    return undefined;
  }
  const opfXml = strFromU8(files[opfPath] ?? new Uint8Array());
  if (opfXml === '') return undefined;

  // <meta name="cover" content="cover-img"/>（属性顺序两种写法都收）
  const coverId =
    /<meta[^>]*name\s*=\s*"cover"[^>]*content\s*=\s*"([^"]+)"/i.exec(opfXml)?.[1] ??
    /<meta[^>]*content\s*=\s*"([^"]+)"[^>]*name\s*=\s*"cover"/i.exec(opfXml)?.[1];

  const items = readTags(opfXml, 'item')
    .map((item) => ({
      id: item['id'] ?? '',
      href: item['href'] === undefined ? '' : decodeURIComponent(item['href']),
      mediaType: item['media-type'] ?? '',
      properties: item['properties'] ?? '',
    }))
    .filter((item) => item.href !== '');
  const isImage = (item: { mediaType: string; href: string }): boolean =>
    /^image\//i.test(item.mediaType) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(item.href);

  const candidates = [
    items.find((item) => coverId !== undefined && item.id === coverId),
    items.find((item) => /cover-image/i.test(item.properties)),
    items.find((item) => isImage(item) && /cover/i.test(item.id + item.href)),
  ].filter((item): item is (typeof items)[number] => item !== undefined);

  for (const candidate of candidates) {
    if (!isImage(candidate)) continue;
    const zipPath = resolvePackagePath(opfPath, candidate.href);
    const data = files[zipPath];
    if (data === undefined) continue;
    const ext = sniffImageExt(data);
    if (ext === undefined) continue;
    return { bytes: data, ext };
  }
  return undefined;
}

/** 读大端 Uint16/Uint32（越界返回 0）。 */
function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

/** MOBI 头内 First Image Index 的绝对偏移：16（PalmDOC 头）+ 92（MOBI 头字段）。 */
const MOBI_FIRST_IMAGE_OFFSET = 108;

/**
 * MOBI 封面：EXTH 201（coverOffset）/ 202（thumbOffset）相对 First Image Index 定位图片记录；
 * 缺 EXTH 时退化为「First Image Index 起第一张能识别出魔数的记录」。
 */
export function extractMobiCover(bytes: Uint8Array): CoverBytes | undefined {
  if (bytes.length < 78) return undefined;
  const type = String.fromCharCode(bytes[60] ?? 0, bytes[61] ?? 0, bytes[62] ?? 0, bytes[63] ?? 0);
  if (type !== 'BOOK' && type !== 'TEXt') return undefined;
  const recordCount = u16(bytes, 76);
  if (recordCount < 2) return undefined;
  const recordOffset = (index: number): number => u32(bytes, 78 + index * 8);
  const recordBytes = (index: number): Uint8Array | undefined => {
    if (index < 0 || index >= recordCount) return undefined;
    const start = recordOffset(index);
    const end = index + 1 < recordCount ? recordOffset(index + 1) : bytes.length;
    if (end <= start || end > bytes.length) return undefined;
    return bytes.subarray(start, end);
  };

  const r0 = recordBytes(0);
  if (r0 === undefined) return undefined;

  // EXTH 201 / 202
  let coverOffset: number | undefined;
  let thumbOffset: number | undefined;
  const mobiMagic = String.fromCharCode(r0[16] ?? 0, r0[17] ?? 0, r0[18] ?? 0, r0[19] ?? 0);
  if (mobiMagic === 'MOBI') {
    const headerLength = u32(r0, 20);
    const exthStart = 16 + headerLength;
    if (
      exthStart + 12 <= r0.length &&
      String.fromCharCode(r0[exthStart] ?? 0, r0[exthStart + 1] ?? 0, r0[exthStart + 2] ?? 0, r0[exthStart + 3] ?? 0) === 'EXTH'
    ) {
      const exthCount = u32(r0, exthStart + 8);
      let p = exthStart + 12;
      for (let n = 0; n < exthCount && p + 8 <= r0.length; n += 1) {
        const recType = u32(r0, p);
        const recLen = u32(r0, p + 4);
        if (recLen < 8 || p + recLen > r0.length) break;
        if (recType === 201) coverOffset = u32(r0, p + 8);
        if (recType === 202) thumbOffset = u32(r0, p + 8);
        p += recLen;
      }
    }
  }

  const firstImage = r0.length > MOBI_FIRST_IMAGE_OFFSET + 4 ? u32(r0, MOBI_FIRST_IMAGE_OFFSET) : 0;
  const tryRecord = (index: number): CoverBytes | undefined => {
    if (index <= 0) return undefined;
    const data = recordBytes(index);
    if (data === undefined || data.length === 0) return undefined;
    const ext = sniffImageExtDeep(data);
    if (ext === undefined) return undefined;
    return { bytes: trimToMagic(data), ext };
  };

  if (coverOffset !== undefined && firstImage > 0) {
    const found = tryRecord(firstImage + coverOffset);
    if (found !== undefined) return found;
  }
  if (thumbOffset !== undefined && firstImage > 0) {
    const found = tryRecord(firstImage + thumbOffset);
    if (found !== undefined) return found;
  }
  if (firstImage > 0) {
    for (let index = firstImage; index < recordCount; index += 1) {
      const found = tryRecord(index);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** cover.json 的结构。 */
interface CoverIndex {
  file?: string;
  none?: boolean;
}

/** 书库目录中的封面路径（不含扩展名的判定交给 cover.json）。 */
function coverIndexPath(bookDir: string): string {
  return join(bookDir, 'cover.json');
}

/** 读取 cover.json（不存在返回 undefined）。 */
async function readCoverIndex(bookDir: string): Promise<CoverIndex | undefined> {
  try {
    return JSON.parse(await readFile(coverIndexPath(bookDir), 'utf8')) as CoverIndex;
  } catch {
    return undefined;
  }
}

/** 封面 Content-Type 由扩展名推得。 */
function coverContentType(ext: string): string {
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return table[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** 有封面的格式（其余走客户端生成式封面）。 */
function hasExtractableCover(format: BookFormat): boolean {
  return format === 'epub' || format === 'mobi';
}

/** 提取并落盘封面；返回是否有封面。已判定过（含「确认无封面」）时直接返回缓存结论。 */
export async function ensureBookCover(paths: StorePathsLike, book: Book): Promise<boolean> {
  const dir = join(paths.libraryDir, book.id);
  const cached = await readCoverIndex(dir);
  if (cached !== undefined) return cached.file !== undefined;

  if (!hasExtractableCover(book.format)) {
    await writeCoverIndex(dir, { none: true });
    return false;
  }
  try {
    const raw = await readFile(join(dir, 'book.' + book.format));
    const cover = book.format === 'epub' ? extractEpubCover(raw) : extractMobiCover(raw);
    if (cover === undefined) {
      await writeCoverIndex(dir, { none: true });
      return false;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cover.' + cover.ext), cover.bytes);
    await writeCoverIndex(dir, { file: 'cover.' + cover.ext });
    return true;
  } catch {
    // 解析失败（损坏文件 / 不支持的压缩）→ 记「无封面」，不让请求反复重试
    await writeCoverIndex(dir, { none: true });
    return false;
  }
}

/** 写 cover.json（失败静默：封面只是显示优化，不应让调用方失败）。 */
async function writeCoverIndex(dir: string, index: CoverIndex): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(coverIndexPath(dir), JSON.stringify(index), 'utf8');
  } catch {
    // ignore
  }
}

/** 读取封面字节（懒提取：首次访问时提取并缓存）。 */
export async function readCover(
  paths: StorePathsLike,
  book: Book,
): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const dir = join(paths.libraryDir, book.id);
  await ensureBookCover(paths, book);
  const index = await readCoverIndex(dir);
  if (index?.file === undefined) return undefined;
  try {
    const bytes = await readFile(join(dir, index.file));
    const ext = index.file.split('.').pop() ?? '';
    return { bytes, contentType: coverContentType(ext) };
  } catch {
    return undefined;
  }
}

/** 导出给测试：按扩展名推 Content-Type。 */
export { coverContentType };
