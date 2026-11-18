/**
 * 网页书源：站点适配器 + 抓取编排。
 *
 * 设计约束（都来自实测，不是偏好）：
 * 1. **Host 沙箱里没有 `fetch`**（`NODE_API_REDIRECTS` 里是 trap，调用即抛），
 *    所以抓取能力由外部注入（`FetchHtml`），实际实现走 `ctx.web.fetch`。
 * 2. **不引第三方 HTML 解析库**：目标站正文容器内只有 `<p>`，字符串扫描足够；
 *    引 parse5 会给 Host 产物增加数百 KB。`SiteAdapter` 接口留好，
 *    将来站点结构复杂化时只需换一个适配器内部实现。
 * 3. **HTML 一律不原样入库**：只提段落纯文本，由 store 层层重新转义成 `<p>`。
 *    抓来的 HTML 原样入库会把注入面扩散到所有消费方。
 *
 * 站点知识（选择器、URL 规律、编码）来自本次实测，见
 * `docs/web-source/03-site-parsing.md`；通道约束见 `docs/web-source/02-fetch-channel.md`。
 */
import type { WebCatalog, WebChapterBody, WebChapterRef } from './shared/types.ts';

/** 一次抓取拿到的页面。 */
export interface FetchedPage {
  /** 解码后的 HTML。 */
  html: string;
  /**
   * 是否被抓取后端截断（`ctx.web.fetch` 的 `truncated`）。
   *
   * 目录页实测 135,879 字符 > 后端 100,000 字符上限，**必然截断**；
   * 编排层据此决定「目录不完整，需要用章节链继续扩展」。
   */
  truncated: boolean;
}

/**
 * 抓取能力：由 Host 注入。
 * @param url - 绝对 URL。
 * @returns 页面 HTML 与截断标记；非 2xx、超时、编码异常等一律抛错。
 */
export type FetchHtml = (url: string) => Promise<FetchedPage>;

/** 站点适配器契约：一个站点一个实现，互不 import。 */
export interface SiteAdapter {
  /** 站点标识，写进 `Book.siteId`。 */
  readonly id: string;
  /** 这个 URL 是否归本适配器管。 */
  matches(url: URL): boolean;
  /**
   * 抓目录：入口 URL 可以是目录页 / 书籍详情页 / 章节页，由适配器自行判定并跳转。
   *
   * @param fetchHtml - 抓取能力。
   * @param entryUrl - 用户填的入口 URL。
   * @param entryPage - 已经抓好的入口页（避免重复抓一次）。
   */
  fetchCatalog(fetchHtml: FetchHtml, entryUrl: string, entryPage: FetchedPage): Promise<WebCatalog>;
  /**
   * 抓单章正文。
   * @param fetchHtml - 抓取能力。
   * @param chapter - 目录里的一章。
   */
  fetchChapter(fetchHtml: FetchHtml, chapter: WebChapterRef): Promise<WebChapterBody>;
}

// ---------------------------------------------------------------------------
// HTML 文本工具（不引依赖，够用即可）
// ---------------------------------------------------------------------------

/** 常见命名实体表（目标站正文里出现过的与通用必需项）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

/**
 * 反转义 HTML 实体（命名实体 + 十进制 + 十六进制）。
 * @param text - 可能含实体的文本。
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * 剥掉所有标签并反转义实体。
 *
 * 注意**不做空白折叠**：中文小说段落内部的空格（含段首全角缩进）是版面信息，
 * 只由调用方 `trim()` 首尾。原文里章节名内部可能出现连续空格（末章是「第一千二百二十七章  大結局」），
 * 折叠会改变标题。
 * @param html - 片段 HTML。
 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/**
 * 从某个位置开始收集**连续的 `<p>` 文本**，遇到第一个非 `<p>` 结构元素即停。
 *
 * 为什么不用「div 标签配平」来划定正文范围：**真实站点 HTML 的 div 并不配平**
 * （实测样本页 48 个 `<div` 对 45 个 `</div>`，浏览器靠 HTML5 容错解析）。
 * 配平失败一旦回落成「整页扫描」，就会把导航、页脚里的 `<p>` 当成正文入库 ——
 * 静默污染，比报错糟得多。而目标站正文容器内本来就只有 `<p>`（见 03-site-parsing §3.1），
 * 因此「从容器起点顺序吃掉一段连续 `<p>`」既有界又不依赖配平。
 *
 * @param html - 整页 HTML。
 * @param fromIndex - 扫描起点（通常是正文容器开始标签之后的位置）。
 * @returns 段落文本数组（已剥标签、反转义、去空段）。
 */
export function collectParagraphRun(html: string, fromIndex: number): string[] {
  const paragraphs: string[] = [];
  let cursor = fromIndex;
  while (cursor < html.length) {
    // 跳过空白与注释，允许段落之间出现任意排版空白
    const gap = /^(?:\s+|<!--[\s\S]*?-->)+/.exec(html.slice(cursor, cursor + 2000));
    if (gap !== null) cursor += gap[0].length;
    const openTag = /^<p\b[^>]*>/i.exec(html.slice(cursor, cursor + 500));
    if (openTag === null) break;
    const contentStart = cursor + openTag[0].length;
    const close = html.toLowerCase().indexOf('</p>', contentStart);
    if (close < 0) break;
    const text = stripTags(html.slice(contentStart, close)).trim();
    if (text !== '') paragraphs.push(text);
    cursor = close + 4;
  }
  return paragraphs;
}

/**
 * 定位正文容器并取出段落。
 *
 * 依次尝试三种定位方式，任一命中即用（都不命中就返回空数组，由调用方按「解析失败」报错）：
 * 1. `class="read-content"`（目标站正文容器，最精确）；
 * 2. `id="j_readMainWrap"`（正文大容器，回退）；
 * 3. `<article>` / `<main>`（通用回退，便于接入其他站点）。
 *
 * @param html - 整页 HTML。
 */
export function extractBodyParagraphs(html: string): string[] {
  const markers: RegExp[] = [
    /\bclass\s*=\s*["'][^"']*\bread-content\b[^>]*>/i,
    /\bid\s*=\s*["']j_readMainWrap["'][^>]*>/i,
    /<article\b[^>]*>/i,
    /<main\b[^>]*>/i,
  ];
  for (const marker of markers) {
    const match = marker.exec(html);
    if (match === null) continue;
    const paragraphs = collectParagraphRun(html, match.index + match[0].length);
    if (paragraphs.length > 0) return paragraphs;
  }
  return [];
}

/**
 * 从某个已知位置向前找到最近的 `<div` 起点，然后做标签配平扫描，返回该 div 的范围。
 *
 * ⚠️ **仅适用于配平良好的 HTML**（自测夹具、未来的规范化页面）。
 * 真实站点页面存在 div 不配平的情况，正文抽取请用 {@link extractBodyParagraphs}。
 *
 * @param html - 整页 HTML。
 * @param markerIndex - 已知标记（如 `id="j_readMainWrap"`）在 html 中的下标。
 * @returns `{ start, end }`（end 为闭合标签之后的第一个字符下标）；找不到返回 undefined。
 */
export function findEnclosingDiv(html: string, markerIndex: number): { start: number; end: number } | undefined {
  const start = html.lastIndexOf('<div', markerIndex);
  if (start < 0) return undefined;
  let depth = 0;
  let cursor = start;
  const openRe = /<div\b/gi;
  const closeRe = /<\/div\s*>/gi;
  while (cursor < html.length) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (close === null) return undefined;
    if (open !== null && open.index < close.index) {
      depth += 1;
      cursor = open.index + 4;
      continue;
    }
    depth -= 1;
    cursor = close.index + close[0].length;
    if (depth === 0) return { start, end: cursor };
  }
  return undefined;
}

/**
 * 取某个开始标签上的属性值。
 * @param tag - 开始标签原文（如 `<div class="text-wrap" data-nurl="/book/1/2.html">`）。
 * @param name - 属性名（大小写不敏感）。
 */
export function readAttribute(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(tag);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

/** 把相对链接绝对化；解析失败返回 undefined（不抛错，调用方决定是否致命）。 */
function absolutize(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// alicesw.tw 适配器（首个支持的站点）
// ---------------------------------------------------------------------------

/** 站点判定：alicesw.tw / alicesw.com（含 www 与裸域）。 */
const ALICESW_HOST = /(^|\.)alicesw\.(tw|com)$/i;

/** 目录页：`/other/chapters/id/<novelId>.html`。 */
const ALICESW_CHAPTERS_PATH = /^\/other\/chapters\/id\/\d+\.html$/;
/** 书籍详情页：`/novel/<novelId>.html`。 */
const ALICESW_NOVEL_PATH = /^\/novel\/\d+\.html$/;
/** 章节正文页：`/book/<bookId>/<chapterId>.html`。 */
const ALICESW_CHAPTER_PATH = /^\/book\/\d+\/[0-9a-fA-F]+\.html$/;

/** 正文最少字数：低于它就当解析失败（站点改版的第一现场），绝不静默入库。 */
const MIN_CHAPTER_CHARS = 50;

/** 解析 alicesw 目录页的章节列表（`ul.mulu_list` 内一次给全，无分页）。 */
function parseAliceswChapterList(pageHtml: string, pageUrl: string): Array<{ title: string; url: string }> {
  const listStart = pageHtml.search(/<ul[^>]*\bmulu_list\b/i);
  if (listStart < 0) return [];
  const listEnd = pageHtml.indexOf('</ul>', listStart);
  const scope = listEnd < 0 ? pageHtml.slice(listStart) : pageHtml.slice(listStart, listEnd);
  const anchors = scope.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const result: Array<{ title: string; url: string }> = [];
  for (const anchor of anchors) {
    const href = anchor[1];
    const label = stripTags(anchor[2] ?? '').trim();
    if (href === undefined || label === '') continue;
    const url = absolutize(href, pageUrl);
    if (url === undefined) continue;
    result.push({ title: label, url });
  }
  return result;
}

/** 从页面里取书名（目录页 `.mu_h1 h1` / 书籍页与章节页 `.text-info .info a` 的第一个）。 */
function parseAliceswTitle(pageHtml: string): string | undefined {
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(pageHtml);
  if (heading !== null) {
    const text = stripTags(heading[1] ?? '').trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** 从章节页/书籍页取书名（`.text-info .info a` 的第一个链接文字）。 */
function parseAliceswBookNameFromInfo(pageHtml: string): string | undefined {
  const infoStart = pageHtml.search(/<div[^>]*\btext-info\b/i);
  if (infoStart < 0) return undefined;
  const segment = pageHtml.slice(infoStart, infoStart + 2000);
  const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(segment);
  if (anchor === null) return undefined;
  const text = stripTags(anchor[1] ?? '').trim();
  return text === '' ? undefined : text;
}

/** 从书籍详情页找目录页链接（`.book_newchap .tit a[href^="/other/chapters/id/"]`）。 */
function parseAliceswCatalogLink(pageHtml: string, pageUrl: string): string | undefined {
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']*\/other\/chapters\/id\/\d+\.html)["'][^>]*>/i.exec(pageHtml);
  if (anchor === null || anchor[1] === undefined) return undefined;
  return absolutize(anchor[1], pageUrl);
}

/** 从章节页找所属书籍详情页链接（`.text-info .info a` 指向 `/novel/<id>.html`）。 */
function parseAliceswNovelLink(pageHtml: string, pageUrl: string): string | undefined {
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']*\/novel\/\d+\.html)["'][^>]*>/i.exec(pageHtml);
  if (anchor === null || anchor[1] === undefined) return undefined;
  return absolutize(anchor[1], pageUrl);
}

/** 把 `ul.mulu_list` 解析结果转成目录对象。 */
function toCatalog(
  entries: Array<{ title: string; url: string }>,
  title: string,
  author: string | undefined,
  warnings: string[],
): WebCatalog {
  return {
    title: title.trim() === '' ? '(未命名网页书)' : title.trim(),
    author,
    siteId: aliceswAdapter.id,
    chapters: entries.map((entry, index) => ({ index, title: entry.title, url: entry.url })),
    warnings,
  };
}

/** alicesw.tw 站点适配器。 */
export const aliceswAdapter: SiteAdapter = {
  id: 'alicesw',

  matches(url: URL): boolean {
    return ALICESW_HOST.test(url.hostname);
  },

  async fetchCatalog(fetchHtml: FetchHtml, entryUrl: string, entryPage: FetchedPage): Promise<WebCatalog> {
    const warnings: string[] = [];
    /** 逐级从入口页导航到目录页，最多两跳（章节页 → 书籍页 → 目录页）。 */
    let pageHtml = entryPage.html;
    let pageUrl = entryUrl;
    let pageTruncated = entryPage.truncated;
    let title = '';
    let author: string | undefined;

    for (let hop = 0; hop < 3; hop += 1) {
      const path = new URL(pageUrl).pathname;
      if (ALICESW_CHAPTERS_PATH.test(path)) {
        // 目录页：直接解析
        const entries = parseAliceswChapterList(pageHtml, pageUrl);
        if (entries.length === 0) {
          throw new Error('目录页里没有解析到任何章节（站点结构可能已改版），已中止建书');
        }
        if (pageTruncated) {
          // 目录页实测 135,879 字符 > 抓取后端 100,000 字符上限 ⇒ 必然截断，
          // 尾部章节只能靠正文页的「下一章」链在抓取过程中补齐（见 fetchWebChapters）
          warnings.push('目录页超出单次抓取上限被截断，先按已解析到的章节建书，其余章节会随抓取逐章补齐');
        }
        title = parseAliceswTitle(pageHtml) ?? '';
        return toCatalog(entries, title, author, warnings);
      }
      if (ALICESW_NOVEL_PATH.test(path)) {
        // 书籍详情页：找目录入口
        const catalogUrl = parseAliceswCatalogLink(pageHtml, pageUrl);
        title = parseAliceswTitle(pageHtml) ?? parseAliceswBookNameFromInfo(pageHtml) ?? '';
        if (catalogUrl === undefined) {
          throw new Error('书籍页里没有找到目录入口（站点结构可能已改版），已中止建书');
        }
        pageUrl = catalogUrl;
        const next = await fetchHtml(pageUrl);
        pageHtml = next.html;
        pageTruncated = next.truncated;
        continue;
      }
      if (ALICESW_CHAPTER_PATH.test(path)) {
        // 章节页：先回到书籍详情页
        const novelUrl = parseAliceswNovelLink(pageHtml, pageUrl);
        if (novelUrl === undefined) {
          throw new Error('章节页里没有找到所属书籍链接，请改填目录页或书籍页 URL');
        }
        pageUrl = novelUrl;
        const next = await fetchHtml(pageUrl);
        pageHtml = next.html;
        pageTruncated = next.truncated;
        author = undefined;
        continue;
      }
      throw new Error(`不支持的页面地址：${pageUrl}（请填目录页 /other/chapters/id/<id>.html 或书籍页 /novel/<id>.html）`);
    }
    throw new Error('导航到目录页失败：URL 层级超出预期');
  },

  async fetchChapter(fetchHtml: FetchHtml, chapter: WebChapterRef): Promise<WebChapterBody> {
    const page = await fetchHtml(chapter.url);
    const html = page.html;

    // 章标题：正文页是权威（目录标题可能与正文页不一致）
    const heading = /<h3[^>]*\bj_chapterName\b[^>]*>([\s\S]*?)<\/h3>/i.exec(html);
    const title = heading === null ? chapter.title : stripTags(heading[1] ?? '').trim() || chapter.title;

    // 「下一章」：优先 data-nurl（与 DOM 结构解耦，首末章统一用空串表示没有）
    let nextUrl: string | undefined;
    const wrapTag = /<div\b[^>]*\btext-wrap\b[^>]*>/i.exec(html);
    const rawNext = wrapTag === null ? undefined : readAttribute(wrapTag[0], 'data-nurl');
    if (rawNext !== undefined && rawNext.trim() !== '') {
      nextUrl = absolutize(rawNext.trim(), chapter.url);
    }

    // 正文：从正文容器起点顺序吃掉连续 <p>（不依赖 div 配平，见 extractBodyParagraphs 的注释）
    const paragraphs = extractBodyParagraphs(html);

    const chars = paragraphs.reduce((sum, text) => sum + text.length, 0);
    if (paragraphs.length === 0 || chars < MIN_CHAPTER_CHARS) {
      // 站点改版 / 被拦截 / 抓到空壳页的第一现场：必须显式报错，不能静默存一章空正文
      throw new Error(
        `章节正文解析失败（段落 ${paragraphs.length} 个、共 ${chars} 字，阈值 ${MIN_CHAPTER_CHARS} 字）：${chapter.url}`,
      );
    }
    return { title, paragraphs, nextUrl };
  },
};

/** 全部已注册的站点适配器（新增站点只需往这里加一项）。 */
export const SITE_ADAPTERS: readonly SiteAdapter[] = [aliceswAdapter];

/**
 * 按 URL 选适配器。
 * @param entryUrl - 用户填的 URL。
 * @returns 适配器；没有适配器认领时返回 undefined（调用方给「暂不支持该站点」提示）。
 */
export function selectAdapter(entryUrl: string): SiteAdapter | undefined {
  let url: URL;
  try {
    url = new URL(entryUrl);
  } catch {
    return undefined;
  }
  return SITE_ADAPTERS.find((adapter) => adapter.matches(url));
}
