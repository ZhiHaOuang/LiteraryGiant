/**
 * 章节 HTML 的链接/资源重写（纯函数，便于单测）。
 *
 * EPUB/MOBI 章节里的相对路径以**章节文件所在目录**为基准，
 * 而 `/asset` 路由吃的是「包内路径」（相对书根）——两者必须先归一化，
 * 否则 `../images/a.png` 会指向错误位置（实测表现为 asset not found）。
 */

/** 以章节文件所在目录为基准，把相对路径归一化为包内路径。 */
export function resolveChapterPath(chapterHref: string, relative: string): string {
  // 去掉 query / fragment，并解码百分号转义（对比时用明文路径）
  let clean = relative.split('#')[0] ?? relative;
  clean = clean.split('?')[0] ?? clean;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 保留原样（非法转义序列）
  }
  if (clean.startsWith('/')) clean = clean.slice(1);
  // 包内绝对路径（以 / 开头）不拼章节目录，避免 OEBPS/text/OEBPS/... 这类错位
  const isAbsolute = relative.trimStart().startsWith('/');
  const base = chapterHref.includes('/') ? chapterHref.slice(0, chapterHref.lastIndexOf('/')) : '';
  const joined = isAbsolute || base === '' ? clean : `${base}/${clean}`;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** 重写选项。 */
export interface RewriteOptions {
  /** 章节在包内的路径。 */
  chapterHref: string;
  /** 生成受围栏保护的资源 URL。 */
  assetUrl(path: string): string;
}

/** 章节间跳转链接的判定（xhtml / html，可带锚点）。 */
const CHAPTER_LINK = /\.x?html?$/i;

/**
 * 重写章节 HTML 中的 src / href：
 * - 相对资源路径 → 经 `assetUrl` 指向 `/asset`（按章节目录归一化）
 * - 章节间链接 → `data-dsh-chapter-link="<包内路径>"` + `href="#"`，由宿主点击委托切章
 * - 外链 → 补 `target="_blank"`（避免把 GUI 导航走）
 * - 锚点 / data: / mailto: → 原样保留
 */
export function rewriteChapterHtml(html: string, options: RewriteOptions): string {
  return html.replace(/\b(src|href)\s*=\s*"([^"]*)"/gi, (match, attr: string, value: string) => {
    if (value === '') return match;
    // 锚点、内联数据、邮件、协议外链（http/https 单独处理以补 target）
    if (/^(data:|mailto:|javascript:|#)/i.test(value)) return match;
    if (/^https?:/i.test(value)) {
      if (attr.toLowerCase() !== 'href') return match;
      return /target=/i.test(match) ? match : `${match} target="_blank" rel="noreferrer"`;
    }
    const isHref = attr.toLowerCase() === 'href';
    if (isHref && CHAPTER_LINK.test((value.split('#')[0] ?? '').trim())) {
      const target = resolveChapterPath(options.chapterHref, value.split('#')[0] ?? '');
      return `href="#" data-dsh-chapter-link="${target}"`;
    }
    const resolved = resolveChapterPath(options.chapterHref, value);
    return `${attr}="${options.assetUrl(resolved)}"`;
  });
}
