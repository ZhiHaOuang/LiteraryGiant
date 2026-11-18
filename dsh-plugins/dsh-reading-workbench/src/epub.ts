/**
 * EPUB 解析：fflate 解压 → container.xml 定位 OPF → 解析 manifest/spine → 章节列表。
 * 解析产物（章节 HTML）缓存在 library/<bookId>/，运行时按章懒读取。
 */
import { unzipSync, strFromU8 } from 'fflate';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { EpubChapter, EpubManifest } from './shared/types.ts';

/** 从 zip 内提取 package.opf 路径（META-INF/container.xml）。 */
export function locateOpf(files: Record<string, Uint8Array>): string {
  const container = files['META-INF/container.xml'];
  if (container === undefined) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const xml = strFromU8(container);
  const match = /full-path\s*=\s*"([^"]+)"/.exec(xml);
  if (match === null || match[1] === undefined || match[1] === '') {
    throw new Error('container.xml 中未找到 rootfile full-path');
  }
  return match[1];
}

/** 简易 XML 标签属性读取（EPUB 的 OPF/NCX 结构简单，不值得引完整 XML 库）。 */
export function readTags(xml: string, name: string): Array<Record<string, string>> {
  const results: Array<Record<string, string>> = [];
  const pattern = new RegExp(`<${name}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${name}>)`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    const attrPattern = /([a-zA-Z:._-]+)\s*=\s*"([^"]*)"/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(match[1] ?? '')) !== null) {
      attrs[attr[1]!] = attr[2] ?? '';
    }
    if (match[2] !== undefined) attrs['#text'] = match[2];
    results.push(attrs);
  }
  return results;
}

/** 兼容旧名（内部调用）。 */
const tags = readTags;

/**
 * 把「相对 OPF 的路径」解析为「包内路径（相对书根，用 / 分隔）」。
 * 章节 href、manifest 图片 href、ncx src 全部统一到这套坐标系，
 * 与落盘目录结构和 /asset 的 path 参数一致。
 */
export function resolvePackagePath(opfPath: string, relative: string): string {
  const opfDir = dirname(opfPath);
  return normalize(join(opfDir === '.' ? '' : opfDir, relative)).split(sep).join('/');
}

/** 解析 OPF：元数据 + manifest + spine（线性化后即章节顺序）。 */
export function parseOpf(opfXml: string): EpubManifest {
  // 元数据
  const title = tags(opfXml, 'dc:title')[0]?.['#text']?.trim();
  const author = tags(opfXml, 'dc:creator')[0]?.['#text']?.trim();

  // manifest：id → href
  const manifestItems = tags(opfXml, 'item');
  const byId = new Map<string, { href: string; mediaType: string }>();
  for (const item of manifestItems) {
    const id = item['id'];
    const href = item['href'];
    if (id !== undefined && href !== undefined) {
      byId.set(id, { href: decodeURIComponent(href), mediaType: item['media-type'] ?? '' });
    }
  }

  // spine：itemref 顺序
  const spineRefs = tags(opfXml, 'itemref')
    .map((ref) => ref['idref'])
    .filter((id): id is string => id !== undefined);

  const chapters: EpubChapter[] = [];
  spineRefs.forEach((idref) => {
    const item = byId.get(idref);
    if (item === undefined) return;
    if (!/x?html/i.test(item.mediaType)) return;
    const fileName = item.href.split('/').pop() ?? item.href;
    chapters.push({
      index: chapters.length,
      title: decodeURIComponent(fileName.replace(/\.x?html?$/i, '')),
      href: item.href,
    });
  });

  // spine 为空时回退：把 manifest 里的 html 全部按 href 排序当章节
  if (chapters.length === 0) {
    [...byId.values()]
      .filter((item) => /x?html/i.test(item.mediaType))
      .sort((a, b) => a.href.localeCompare(b.href))
      .forEach((item, index) => {
        const fileName = item.href.split('/').pop() ?? item.href;
        chapters.push({
          index,
          title: decodeURIComponent(fileName.replace(/\.x?html?$/i, '')),
          href: item.href,
        });
      });
  }

  const manifest: EpubManifest = { chapters };
  if (title !== undefined && title !== '') manifest.title = title;
  if (author !== undefined && author !== '') manifest.author = author;
  return manifest;
}

/** 解析 toc.ncx 的 navMap：取 (navLabel text, content src) 列表。
 *  注意：v1 按扁平 navPoint 处理，深层嵌套目录的标题匹配可能取到内层项。 */
export function parseNcxTitles(ncxXml: string): Array<{ title: string; src: string }> {
  const results: Array<{ title: string; src: string }> = [];
  for (const point of tags(ncxXml, 'navPoint')) {
    const inner = point['#text'] ?? '';
    const label = /<text[^>]*>([\s\S]*?)<\/text>/i.exec(inner)?.[1]?.trim();
    const src = /<content[^>]*\ssrc\s*=\s*"([^"]*)"/i.exec(inner)?.[1];
    if (label !== undefined && label !== '' && src !== undefined) {
      results.push({ title: label, src: decodeURIComponent(src.split('#')[0]!) });
    }
  }
  return results;
}

/**
 * 解压 EPUB 到书库目录并生成 manifest。
 * 返回 manifest（含元数据），章节 HTML 文件按包内相对路径落盘到 bookDir。
 */
export async function extractEpub(
  bytes: Uint8Array,
  bookDir: string,
): Promise<EpubManifest> {
  const files = unzipSync(bytes);
  if (files['META-INF/container.xml'] === undefined) {
    throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  }
  const opfPath = locateOpf(files);
  const opfXml = strFromU8(files[opfPath] ?? new Uint8Array());
  if (opfXml === '') throw new Error(`EPUB 缺少 package 文件：${opfPath}`);
  const manifest = parseOpf(opfXml);

  // 统一坐标系：章节 href 从「OPF 相对路径」归一化为「包内路径（相对书根）」，
  // 与 /asset 的 path 参数、落盘文件布局一致。
  const toZipPath = (relative: string): string => resolvePackagePath(opfPath, relative);

  // toc.ncx 标题（ncx 一般与 opf 同目录；src 相对 ncx 所在目录）
  const ncxName = /media-type\s*=\s*"application\/x-dtbncx\+xml"[^>]*?href\s*=\s*"([^"]+)"/i.exec(opfXml)?.[1]
    ?? /href\s*=\s*"([^"]+)"[^>]*?media-type\s*=\s*"application\/x-dtbncx\+xml"/i.exec(opfXml)?.[1];
  const navTitles = new Map<string, string>();
  if (ncxName !== undefined) {
    const ncxPath = toZipPath(decodeURIComponent(ncxName));
    const ncxXml = files[ncxPath] !== undefined ? strFromU8(files[ncxPath]) : '';
    if (ncxXml !== '') {
      const ncxDir = dirname(ncxPath);
      for (const entry of parseNcxTitles(ncxXml)) {
        navTitles.set(normalize(join(ncxDir === '.' ? '' : ncxDir, entry.src)).split(sep).join('/'), entry.title);
      }
    }
  }
  for (const chapter of manifest.chapters) {
    chapter.href = toZipPath(chapter.href);
    const title = navTitles.get(chapter.href);
    if (title !== undefined) chapter.title = title;
  }

  // 章节 HTML 落盘（只写章节需要的文件；资源文件也全量落盘供 /asset 读取）
  await mkdir(bookDir, { recursive: true });
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    // 防路径穿越：解析后必须仍在 bookDir 内
    const target = normalize(join(bookDir, path));
    if (!target.startsWith(normalize(bookDir) + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  // ── 章节切分修正（chapterSplit = 2）──
  // 纯标题页并入下一章 + 文件名标题回退。合并文件与本章同目录，书内相对资源路径不变。
  const split = splitChapters(manifest, (href) => {
    const data = files[href];
    return data === undefined ? '' : strFromU8(data);
  });
  manifest.chapters = split.chapters;
  manifest.chapterSplit = CHAPTER_SPLIT_VERSION;
  for (const write of split.writes) {
    const target = normalize(join(bookDir, write.href));
    if (!target.startsWith(normalize(bookDir) + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.html, 'utf8');
  }

  await writeFile(join(bookDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/** 规范化 zip 内相对路径（供 /asset 与章节读取共用）：拒绝越出书根。 */
export function safeZipPath(bookDir: string, relative: string): string | undefined {
  const target = normalize(join(bookDir, relative));
  if (!target.startsWith(normalize(bookDir) + sep)) return undefined;
  return target;
}

// ───────────────────────────────────────────────────────────────────────────
// 章节切分修正（chapterSplit = 2）
//
// 背景：EPUB 的 spine 是「文件清单」，不是「逻辑章节」。实测《情绪流龙头战法》里
// 「第一章 股市的起源和本质」是一个 12 字的纯标题文件，正文在下一个 spine 文件
// （`chapter007` → 第一节 股市的起源）。旧实现按文件切章，用户点「第一章」只看到
// 一行标题，翻一页就到「第二节」，观感是「这一章没读完就进下一章」。
//
// 修正两件事（都不改 index，保护旧进度锚点与划线锚点）：
// 1. 纯标题页标记 `skip`，其内容并进下一章正文（写成同目录的 `.merged.xhtml`）；
// 2. 文件名式标题（`chapter007`）从正文 h1~h6 回退提取真实标题。
// ───────────────────────────────────────────────────────────────────────────

/** 章节切分逻辑版本（写进 manifest 的 `chapterSplit`，老书库据此就地重算）。 */
export const CHAPTER_SPLIT_VERSION = 2;

/**
 * 纯标题页的最大可见字数。
 *
 * 取 60 而不是更大：实测全库有些 spine 页是「标题 + 一段 70~110 字的导语/题记」，
 * 把它们并进下一章会让导语变成正文开头，反而破坏阅读节奏；这类页面应当保留为独立章。
 */
const TITLE_PAGE_MAX_CHARS = 60;

/** 标题页里单段允许的最大字数（出现更长段落即视为正文页）。 */
const TITLE_PAGE_MAX_PARAGRAPH = 60;

/** 文件名式标题：`chapter012` / `part0006` / `chapter014_0001` / `c12` / `12`。 */
const FILE_NAME_TITLE = /^(?:chapter|chap|ch|part|section|text|page|c|p)?[0-9][0-9_-]*$/i;

/** 剥标签 + 解常见实体 + 折叠空白。`<br>` 视为分隔，避免把两行拼成一个词。 */
export function textOfHtml(fragment: string): string {
  return fragment
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取 `<body>` 内部 HTML；没有 body 标签时返回原串。 */
export function bodyOfHtml(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return body?.[1] ?? html;
}

/**
 * 是否是「只有标题、没有正文」的页面。
 *
 * 判据刻意保守：可见文字 ≤ 120 且所有段落都 ≤ 60 字。
 * 有图片的页（封面）文字为空，不判为标题页（避免把封面并进正文）。
 */
export function isTitleOnlyPage(body: string): boolean {
  const text = textOfHtml(body).replace(/\s+/g, '');
  if (text === '' || text.length > TITLE_PAGE_MAX_CHARS) return false;
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => textOfHtml(match[1] ?? ''));
  return paragraphs.every((paragraph) => paragraph.length <= TITLE_PAGE_MAX_PARAGRAPH);
}

/**
 * 从章节正文里提取标题（优先 h1~h3 标题级元素，其次首个短块）。
 *
 * 只取 h1~h3：h4~h6 常被 calibre 排版成正文小标题（实测《情绪流龙头战法》里
 * `chapter007` 的 h3 是「第一节 / 股市的起源」，紧跟的 h4 是「1. 16世纪…」正文小节）。
 */
export function titleFromBody(body: string): string | undefined {
  const headings = [...body.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => textOfHtml(match[2] ?? ''))
    .filter((text) => text !== '');
  const fromHeadings = headings.slice(0, 3).join(' ').trim();
  if (fromHeadings !== '' && fromHeadings.length <= 60) return fromHeadings;
  const firstBlock = /<(p|div)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  const fromBlock = firstBlock === null ? '' : textOfHtml(firstBlock[2] ?? '');
  if (fromBlock !== '' && fromBlock.length <= 40 && !/[。！？；：]$/.test(fromBlock)) return fromBlock;
  return undefined;
}

/** 合并后章节文件路径（与原章同目录，保证书内相对资源路径不变）。 */
export function mergedHrefOf(href: string): string {
  if (/\.merged\.x?html?$/i.test(href)) return href;
  return href.replace(/(\.x?html?)$/i, '.merged$1');
}

/** 用新 body 内容重包一个章节 HTML（保留原 `<head>` 与 `<html>` 属性）。 */
export function wrapChapterHtml(originalHtml: string, body: string): string {
  const htmlOpen = /<html\b[^>]*>/i.exec(originalHtml)?.[0] ?? '<html>';
  const head = /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(originalHtml)?.[0] ?? '<head><meta charset="utf-8"></head>';
  return `<!DOCTYPE html>\n${htmlOpen}\n${head}\n<body>\n${body}\n</body>\n</html>\n`;
}

/** 一个待写出的合并章节文件。 */
export interface MergedChapterWrite {
  /** 包内路径（相对书根）。 */
  href: string;
  html: string;
}

/**
 * 修正章节切分（纯函数，不碰 IO，便于自测）。
 *
 * @param manifest - 待修正的 manifest（不修改入参）。
 * @param htmlOf - 按包内路径取章节 HTML（取不到返回空串）。
 * @returns 新章节数组 + 需要落盘的合并文件。
 */
export function splitChapters(
  manifest: EpubManifest,
  htmlOf: (href: string) => string,
): { chapters: EpubChapter[]; writes: MergedChapterWrite[] } {
  const chapters: EpubChapter[] = manifest.chapters.map((chapter) => ({ ...chapter }));
  const writes: MergedChapterWrite[] = [];
  /** 待并入下一章的 body 片段（可能连续多个标题页）。 */
  let carry: string[] = [];

  chapters.forEach((chapter, position) => {
    const html = htmlOf(chapter.href);
    const body = html === '' ? '' : bodyOfHtml(html);
    const isLast = position === chapters.length - 1;

    if (!isLast && isTitleOnlyPage(body)) {
      chapter.skip = true;
      carry.push(body);
      return;
    }

    if (carry.length > 0) {
      const mergedHref = mergedHrefOf(chapter.href);
      writes.push({ href: mergedHref, html: wrapChapterHtml(html, `${carry.join('\n')}\n${body}`) });
      chapter.href = mergedHref;
      carry = [];
    }

    if (FILE_NAME_TITLE.test(chapter.title.trim())) {
      const derived = titleFromBody(body);
      if (derived !== undefined) chapter.title = derived;
    }
  });

  // 末尾连续标题页没有下一章可并：退回原样（保持可达，取消 skip）
  if (carry.length > 0) {
    for (let position = chapters.length - 1; position >= 0; position -= 1) {
      const chapter = chapters[position]!;
      if (chapter.skip !== true) break;
      chapter.skip = false;
    }
  }

  return { chapters, writes };
}
