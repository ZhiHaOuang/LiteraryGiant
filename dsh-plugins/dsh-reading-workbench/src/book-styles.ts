/**
 * 书内样式表收集（Host 半）。
 *
 * 为什么需要这个模块：EPUB 的排版层次**只存在于书内 CSS 里**——
 * 大量中文 EPUB（calibre 转换的居多）正文标题写成
 * `<p class="calibre_1"><span class="calibre5"><span class="bold">…</span></span></p>`，
 * 没有任何 `<h1>` 语义标签。样式表一丢，标题就退化成普通段落，整章同字号同字重
 * （2026-10-19 用户反馈「进入 epub 后文字全都是一样的」的根因）。
 *
 * 收集策略：解压目录里**所有 `.css`** 按包内路径排序合并。不读 OPF 的 media-type 清单，
 * 是因为 OPF 路径本身不固定（`content.opf` / `OEBPS/content.opf` 都有），
 * 而 extractEpub 已经把整包原样落盘，扫一遍比再解析一次 XML 更可靠。
 *
 * 只做「取出来」这一件事：作用域化、属性过滤、url 重写全部在客户端做
 * （见 `client/book-css.ts`）——Host 侧只掌握真实 IO，渲染策略属于视图层。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { BookFormat, BookStylesPayload } from './shared/types.ts';

/** 单份 CSS 上限：正常 EPUB 的样式表只有几 KB，256KB 已是异常值的上限，防止把宿主读爆。 */
export const MAX_STYLE_FILE_BYTES = 256 * 1024;

/** 合并后的总上限：超出部分直接截断并记 warning，不做无上限拼接。 */
export const MAX_STYLE_TOTAL_BYTES = 1024 * 1024;

/** 空结果（非 epub，或整包没有 CSS）。 */
function emptyPayload(warnings: string[] = []): BookStylesPayload {
  return { css: '', files: [], warnings };
}

/**
 * 递归列出目录下所有 `.css` 文件（包内相对路径，统一用 `/` 分隔）。
 * 读取失败（目录不存在等）一律返回空数组，由调用方决定是否记 warning。
 */
async function listCssFiles(bookDir: string): Promise<string[]> {
  let entries: Array<{ name: string; parentPath?: string; isFile(): boolean }>;
  try {
    // recursive 需要 Node 20+：DSH 运行时满足；失败时下面 catch 兜成空清单。
    entries = (await readdir(bookDir, { recursive: true, withFileTypes: true })) as unknown as Array<{
      name: string;
      parentPath?: string;
      isFile(): boolean;
    }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.css$/i.test(entry.name)) continue;
    // ⚠️ `Dirent.parentPath` 是**绝对路径**（Node 20+ 的 recursive readdir 如此），
    // 直接拼 `${parentPath}/${name}` 会得到绝对路径，随后 join(bookDir, 绝对路径) 读不到
    // ——2026-10-20 真机首测就踩到：/styles 返回 200 但 css 为空、warnings 里全是「读取失败」。
    // 必须先用 path.relative 折回「相对书根」的坐标系。
    const relPath =
      entry.parentPath === undefined ? entry.name : join(relativeFrom(bookDir, entry.parentPath), entry.name);
    files.push(relPath.split(sep).join('/'));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/** 相对路径归一化：去掉开头的 `.` 段，空串表示就在 bookDir 下。 */
function relativeFrom(bookDir: string, target: string): string {
  const rel = relative(bookDir, target);
  return rel === '' || rel === '.' ? '' : rel;
}

/**
 * 收集一本书的书内样式表。
 *
 * @param bookDir - 该书在书库里的解压目录（`library/<id>/`）。
 * @param format - 书籍格式；只有 `epub` 可能带书内 CSS。
 * @returns 合并后的 CSS 文本 + 参与的包内路径 + 非致命告警。
 */
export async function collectBookStyles(bookDir: string, format: BookFormat): Promise<BookStylesPayload> {
  if (format !== 'epub') return emptyPayload();
  const files = await listCssFiles(bookDir);
  if (files.length === 0) return emptyPayload();

  const warnings: string[] = [];
  const parts: string[] = [];
  const used: string[] = [];
  // ⚠️ 不能用 Buffer：Host 半跑在 vm 沙箱里，`Buffer` 是 undefined
  // （见工作区 AGENTS.md §4.0）。sizeof 用 TextEncoder，沙箱里可用。
  const encoder = new TextEncoder();
  let total = 0;
  for (const relative of files) {
    let text: string;
    try {
      text = await readFile(join(bookDir, relative), 'utf8');
    } catch {
      warnings.push(`${relative}：读取失败，已跳过`);
      continue;
    }
    const bytes = encoder.encode(text).length;
    if (bytes > MAX_STYLE_FILE_BYTES) {
      warnings.push(`${relative}：超过 ${MAX_STYLE_FILE_BYTES} 字节上限，已跳过`);
      continue;
    }
    if (total + bytes > MAX_STYLE_TOTAL_BYTES) {
      warnings.push(`${relative}：合并总量超过 ${MAX_STYLE_TOTAL_BYTES} 字节上限，已截断`);
      break;
    }
    total += bytes;
    used.push(relative);
    // 保留来源注释：排查「这条规则是哪份表来的」时不用回去翻 zip
    parts.push(`/* ${relative} */\n${text}`);
  }
  return { css: parts.join('\n'), files: used, warnings };
}
