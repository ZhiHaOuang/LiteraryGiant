/**
 * data.json 存储层：现读现写，不做内存全量缓存，
 * 规避热重载与外部编辑造成的双写冲突。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  Book,
  BookFormat,
  CreateHighlightRequest,
  EpubManifest,
  Highlight,
  ImportBookRequest,
  ReaderSettings,
  SaveSettingsRequest,
  UploadBookRequest,
  WebBookState,
  WebChapterRef,
  WorkbenchData,
} from './shared/types.ts';
import { SCHEMA_VERSION } from './shared/types.ts';
import { decodeTextBytes, inspectReplacementDamage } from './shared/text-encoding.ts';

/** 数据文件解析结果。 */
export interface StorePaths {
  dir: string;
  file: string;
  /** 导入书籍的存放根目录。 */
  libraryDir: string;
}

/**
 * 解析插件数据目录：~/.dsh/reading-workbench。
 *
 * 注意：DSH 把插件 Host 半放进 vm 沙箱执行，沙箱里**没有 `process`**
 * （它属于 NODE_API_REDIRECTS 之外的数据型全局，取值为 undefined）。
 * 因此这里绝不能直接读 `process.env.DSH_HOME`——那会在 apply 阶段抛
 * `ReferenceError: process is not defined`，让整个 Host 半变成 failed。
 * 需要覆盖目录时由调用方（index.ts 从 ctx 服务里取）显式传入。
 * @param dshHome - 已解析好的 DSH 数据根目录；缺省用用户主目录下的 `.dsh`。
 * @returns 插件数据路径集合。
 */
export function resolveStorePaths(dshHome?: string): StorePaths {
  const root = dshHome ?? homedir() + sep + '.dsh';
  const dir = join(root, 'reading-workbench');
  return { dir, file: join(dir, 'data.json'), libraryDir: join(dir, 'library') };
}

/** 默认阅读设置。 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  theme: 'follow',
  columns: 'auto',
  // 默认自动合并折行：老 txt 的硬折行按原样显示会得到一堆半截行，
  // 用户看到的第一眼排版应当是「段落」，而不是原始换行。
  txtReflow: 'auto',
  // 默认恢复原书排版：epub 的层次（标题加粗居中、首行缩进）只写在书内 CSS 里，
  // 不注入就只剩一堆同字号的 <p>（2026-10-19 用户反馈「文字全都是一样的」的根因）。
  bookCss: 'book',
  fontFamily: 'system',
};

/** 空数据结构。 */
function emptyData(): WorkbenchData {
  return {
    schemaVersion: SCHEMA_VERSION,
    books: [],
    progress: {},
    highlights: [],
    settings: { reader: { ...DEFAULT_READER_SETTINGS } },
  };
}

/**
 * 规整阅读设置（老数据缺 columns / txtReflow，超范围字号都在这里收敛）。
 *
 * 兼容性：`txtReflow` 是本轮新加字段，M1/M2 的 data.json 里根本没有它，
 * 读出来是 `undefined`——这里必须给出确定值，否则 UI 会拿到 `undefined`
 * 后再各自兜底，出现「同一次会话里两处默认值不一致」的隐性 bug。
 * 收敛规则刻意做成白名单式：只有 `'preserve'` 被接受，其余（含 `undefined`、
 * 拼错的字符串、数字）一律回落默认的 `'auto'`。
 */
export function normalizeReaderSettings(raw: unknown): ReaderSettings {
  const input = (raw ?? {}) as Partial<ReaderSettings>;
  const fontSize = Number(input.fontSize);
  const lineHeight = Number(input.lineHeight);
  const columns = input.columns;
  return {
    fontSize: Number.isFinite(fontSize) ? Math.min(28, Math.max(13, fontSize)) : DEFAULT_READER_SETTINGS.fontSize,
    lineHeight: Number.isFinite(lineHeight)
      ? Math.min(2.6, Math.max(1.3, lineHeight))
      : DEFAULT_READER_SETTINGS.lineHeight,
    theme: input.theme === 'light' || input.theme === 'dark' ? input.theme : 'follow',
    columns: columns === 1 || columns === 2 || columns === 'auto' ? columns : DEFAULT_READER_SETTINGS.columns,
    txtReflow: input.txtReflow === 'preserve' ? 'preserve' : DEFAULT_READER_SETTINGS.txtReflow,
    // 同样白名单式收敛：只有明确等于 'unified' 才关掉原书排版，
    // 其余（含老数据的 undefined、拼错值）一律恢复原书排版 —— 这是用户期望的默认观感。
    bookCss: input.bookCss === 'unified' ? 'unified' : DEFAULT_READER_SETTINGS.bookCss,
    fontFamily:
      input.fontFamily === 'serif' || input.fontFamily === 'sans'
        ? input.fontFamily
        : DEFAULT_READER_SETTINGS.fontFamily,
  };
}

/** 读取并校验 data.json；不存在或损坏时返回空结构（不抛出）。 */
export async function loadData(paths: StorePaths): Promise<WorkbenchData> {
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch {
    return emptyData();
  }
  try {
    const parsed = JSON.parse(raw) as WorkbenchData;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.books)) {
      return emptyData();
    }
    // 老数据补默认设置（M1 的 data.json 没有 columns 字段）
    parsed.settings = {
      lastOpenedBookId: parsed.settings?.lastOpenedBookId,
      reader: normalizeReaderSettings(parsed.settings?.reader),
    };
    return parsed;
  } catch {
    return emptyData();
  }
}

/** 原子写入 data.json（临时文件 + rename）。 */
export async function saveData(paths: StorePaths, data: WorkbenchData): Promise<void> {
  await mkdir(dirname(paths.file), { recursive: true });
  const tmp = paths.file + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, paths.file);
}

/** 生成稳定 id。 */
export function newId(): string {
  return randomUUID();
}

/** 文本类格式（md/txt：走「解码后存规范 UTF-8 副本」的链路）。 */
export type TextBookFormat = Extract<BookFormat, 'md' | 'txt'>;

/**
 * 文本类建书入口：**必须传原始字节**，编码在这里判定一次，
 * 之后全链路（副本 / REST / 阅读器）都是规范 UTF-8。
 *
 * 为什么必须收字节：调用方一旦先解码（`File.text()` / `readFile(path,'utf8')`），
 * GBK 文件的原始字节就永久丢失了——2026-10-19 的乱码事故正是这么发生的。
 * @param paths - 插件数据路径。
 * @param meta - 书名 / 格式 / 作者 / 来源标记。
 * @param bytes - 文件原始字节。
 * @returns 新建的书目条目。
 */
export async function importTextBookFromBytes(
  paths: StorePaths,
  meta: { title: string; format: TextBookFormat; author?: string; sourcePath: string },
  bytes: Uint8Array,
): Promise<Book> {
  const title = meta.title.trim();
  if (title === '') throw new Error('title 不能为空');
  if (bytes.byteLength === 0) throw new Error('文件内容为空');
  // 编码判定（失败会抛 TextDecodeError，带可操作提示）
  const { text } = decodeTextBytes(bytes);
  if (text.trim() === '') throw new Error('文件内容为空');

  const book: Book = {
    id: newId(),
    title,
    author: meta.author?.trim() || undefined,
    sourcePath: meta.sourcePath,
    format: meta.format,
    addedAt: Date.now(),
    // 文本类没有可提取的封面
    hasCover: false,
  };
  await mkdir(paths.libraryDir, { recursive: true });
  // 书库内以 id 命名副本：原文件后续被移动/删除不影响阅读；
  // 副本始终写规范 UTF-8，读取端不再需要关心原文件编码。
  await writeFile(join(paths.libraryDir, book.id + '.' + book.format), text, 'utf8');
  const data = await loadData(paths);
  data.books.push(book);
  await saveData(paths, data);
  return book;
}

/**
 * 校验导入请求并生成书目条目（按本地绝对路径导入）。
 * @param paths - 插件数据路径。
 * @param request - 含本地路径的导入请求。
 * @param readFileBytes - 读原始字节（**不要传已经解码成字符串的读取器**）。
 * @returns 新建的书目条目。
 */
export async function importBook(
  paths: StorePaths,
  request: ImportBookRequest,
  readFileBytes: (path: string) => Promise<Uint8Array>,
): Promise<Book> {
  const source = String(request.path ?? '').trim();
  if (source === '') throw new Error('path 不能为空');
  const lower = source.toLowerCase();
  const format = lower.endsWith('.md') || lower.endsWith('.markdown') ? 'md' : lower.endsWith('.txt') ? 'txt' : undefined;
  if (!format) throw new Error('仅支持 .md/.markdown/.txt 文件');
  const bytes = await readFileBytes(source);
  return importTextBookFromBytes(
    paths,
    {
      title: request.title?.trim() || source.split(/[\\/]/).pop()?.replace(/\.(md|markdown|txt)$/i, '') || '未命名',
      format,
      author: request.author,
      sourcePath: source,
    },
    bytes,
  );
}

/**
 * 从上传的字符串内容建书（**兼容旧客户端**的 JSON 通道）。
 *
 * 新客户端一律走 `importTextBookFromBytes`（二进制通道）。这里保留是因为
 * 老版本客户端（浏览器缓存未刷新）仍会 POST JSON；但加了损坏闸门：
 * 内容里出现大量 U+FFFD 说明上游已经用错编码解码过，直接拒绝，
 * 避免再次把坏数据固化进书库。
 * @param paths - 插件数据路径。
 * @param request - 含字符串内容的导入请求。
 * @returns 新建的书目条目。
 */
export async function importBookFromContent(paths: StorePaths, request: UploadBookRequest): Promise<Book> {
  const title = String(request.title ?? '').trim();
  if (title === '') throw new Error('title 不能为空');
  const format: BookFormat = request.format === 'txt' ? 'txt' : 'md';
  const content = String(request.content ?? '');
  if (content.trim() === '') throw new Error('文件内容为空');
  const damage = inspectReplacementDamage(content);
  if (damage.damaged) {
    throw new Error(
      `拒绝导入：正文里有 ${damage.count} 个替换符（U+FFFD，占 ${(damage.ratio * 100).toFixed(1)}%），` +
        '说明内容已被错误编码解码过（常见于 GBK/GB2312 老文件）。' +
        '原始字节已经丢失，请刷新页面后重新导入，或先用记事本另存为 UTF-8。',
    );
  }
  const book: Book = {
    id: newId(),
    title,
    author: request.author?.trim() || undefined,
    // 上传来源没有本地路径，用标记串记录来源（UI 不展示）
    sourcePath: `upload:${title}.${format}`,
    format,
    addedAt: Date.now(),
    // 文本类没有可提取的封面（布尔值显式给出，UI 判定不必区分 undefined）
    hasCover: false,
  };
  await mkdir(paths.libraryDir, { recursive: true });
  await writeFile(join(paths.libraryDir, book.id + '.' + format), content, 'utf8');
  const data = await loadData(paths);
  data.books.push(book);
  await saveData(paths, data);
  return book;
}

/** 二进制格式建书（epub/mobi/pdf）：原始字节落库，EPUB 顺带解出章节。 */
export async function importBookFromBinary(
  paths: StorePaths,
  meta: { title: string; format: 'epub' | 'mobi' | 'pdf'; author?: string },
  bytes: Uint8Array,
): Promise<Book> {
  const title = meta.title.trim();
  if (title === '') throw new Error('title 不能为空');
  if (bytes.byteLength === 0) throw new Error('文件内容为空');
  const book: Book = {
    id: newId(),
    title,
    author: meta.author?.trim() || undefined,
    sourcePath: `upload:${title}.${meta.format}`,
    format: meta.format,
    addedAt: Date.now(),
  };
  const bookDir = join(paths.libraryDir, book.id);
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, 'book.' + meta.format), bytes);
  const data = await loadData(paths);

  if (meta.format === 'epub') {
    // 解压 + 解析章节（EPUB 专属；失败则书目仍入库，阅读时报解析错误）
    const { extractEpub } = await import('./epub.ts');
    const manifest = await extractEpub(bytes, bookDir);
    if (manifest.title !== undefined && book.title === title) book.title = manifest.title;
    if (manifest.author !== undefined && book.author === undefined) book.author = manifest.author;
  } else if (meta.format === 'mobi') {
    // 解析整本 HTML，包装成"单章清单"复用章节阅读链路（失败则书目仍入库）
    try {
      const { parseMobi } = await import('./mobi.ts');
      const mobi = parseMobi(bytes);
      if (book.title === title && mobi.title !== '') book.title = mobi.title;
      await writeFile(join(bookDir, 'book.html'), mobi.html, 'utf8');
      await writeFile(
        join(bookDir, 'manifest.json'),
        JSON.stringify({ chapters: [{ index: 0, title: book.title, href: 'book.html' }] } satisfies EpubManifest),
        'utf8',
      );
    } catch {
      // 解析失败保留原文件；阅读时会报 manifest 缺失
    }
  }

  // 封面：导入时就探测好（EPUB 解压产物还在手上；MOBI 需要记录表）。
  // 探测失败不影响入库——书架对无封面的书渲染生成式封面。
  try {
    const { ensureBookCover } = await import('./cover.ts');
    book.hasCover = await ensureBookCover(paths, { ...book, sourcePath: book.sourcePath });
  } catch {
    book.hasCover = false;
  }

  data.books.push(book);
  await saveData(paths, data);
  return book;
}

/** 书库中某本书的目录（EPUB/MOBI 用；md/txt 是平面文件）。 */
export function bookDir(paths: StorePaths, book: Book): string {
  return join(paths.libraryDir, book.id);
}

/** 章节切分升级的进行中任务（同一本书并发读 manifest 时只解压一次）。 */
const chapterSplitInFlight = new Map<string, Promise<EpubManifest>>();

/** 老书库就地重算章节切分（幂等；失败写 `chapterSplit: 0` 避免反复重试解压）。 */
async function upgradeChapterSplit(dir: string, manifestPath: string, manifest: EpubManifest): Promise<EpubManifest> {
  const { extractEpub } = await import('./epub.ts');
  try {
    const bytes = new Uint8Array(await readFile(join(dir, 'book.epub')));
    return await extractEpub(bytes, dir);
  } catch {
    // 升级失败不影响阅读：写 chapterSplit=0 标记，避免每次读章都重试解压
    try {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, chapterSplit: 0 }, null, 2), 'utf8');
    } catch {
      /* 标记落盘失败也无所谓：下次读取会再试一次 */
    }
    return manifest;
  }
}

/**
 * 读取 EPUB manifest。
 *
 * 老书库的 manifest 没有 `chapterSplit` 标记（章节切分逻辑升级前导入的），
 * 这里用手上的 `book.epub` **就地重算一次**并落盘，用户不需要重新导入。
 * 重算幂等：解压产物与合并文件都会被覆盖成同一份结果。
 */
export async function readEpubManifest(paths: StorePaths, book: Book): Promise<EpubManifest | undefined> {
  const dir = bookDir(paths, book);
  const manifestPath = join(dir, 'manifest.json');
  let manifest: EpubManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EpubManifest;
  } catch {
    return undefined;
  }
  // mobi / web 书也复用 manifest.json，但它们的章节不是 EPUB spine，不能重算
  if (book.format !== 'epub') return manifest;

  const { CHAPTER_SPLIT_VERSION } = await import('./epub.ts');
  if (manifest.chapterSplit === CHAPTER_SPLIT_VERSION) return manifest;
  // 并发（打开书时 /toc 与 /content 同时到）：同一本书只跑一次解压
  const pending = chapterSplitInFlight.get(dir);
  if (pending !== undefined) return pending;
  const task = upgradeChapterSplit(dir, manifestPath, manifest).finally(() => {
    chapterSplitInFlight.delete(dir);
  });
  chapterSplitInFlight.set(dir, task);
  return task;
}

/**
 * 正文内存缓存：书籍副本一经导入就不再变化，重复打开没必要反复读盘 + 解码。
 * 上限按「本数」控制（每本最多几十 MB 也放得下 8 本）；
 * 用 Map 的插入序做 FIFO 淘汰，够用且无额外依赖。
 */
const CONTENT_CACHE_MAX_BOOKS = 8;
const contentCache = new Map<string, string>();

/** 清空正文缓存（移除书籍 / 重导入 / 测试用）。 */
export function clearContentCache(): void {
  contentCache.clear();
}

/**
 * 读取书籍正文（书库副本优先，缺失时回落原文件）。
 *
 * 两道保护：
 * 1. **缓存**：同一本书重复打开直接命中内存，避免每次读盘 + 解码；
 * 2. **损坏闸门**：读到大量 U+FFFD 说明这份数据在导入时就被错误解码过
 *    （2026-10-19 事故遗留），此时显式报错要求重新导入 —— 原始字节已丢失，
 *    继续渲染只会把乱码当成正常内容给用户看。
 * @param paths - 插件数据路径。
 * @param book - 书目条目。
 * @param readFileUtf8 - 读副本（副本恒为规范 UTF-8）。
 * @returns 正文文本。
 */
export async function readBookContent(
  paths: StorePaths,
  book: Book,
  readFileUtf8: (path: string) => Promise<string>,
): Promise<string> {
  const copy = join(paths.libraryDir, book.id + '.' + book.format);
  const cached = contentCache.get(copy);
  if (cached !== undefined) return cached;

  let content: string;
  try {
    content = await readFileUtf8(copy);
  } catch {
    content = await readFileUtf8(book.sourcePath);
  }
  const damage = inspectReplacementDamage(content);
  if (damage.damaged) {
    throw new Error(
      `《${book.title}》的正文在导入时被错误解码损坏了（替换符 ${damage.count} 个，占 ${(damage.ratio * 100).toFixed(1)}%），` +
        '原始字节已丢失、无法修复。请在书架上移除本书后重新导入原文件。',
    );
  }
  contentCache.set(copy, content);
  while (contentCache.size > CONTENT_CACHE_MAX_BOOKS) {
    const oldest = contentCache.keys().next();
    if (oldest.done === true) break;
    contentCache.delete(oldest.value);
  }
  return content;
}

/** 保存进度。 */
export async function saveProgress(
  paths: StorePaths,
  bookId: string,
  anchor: string,
  percent: number,
): Promise<void> {
  const data = await loadData(paths);
  data.progress[bookId] = { anchor, percent, updatedAt: Date.now() };
  await saveData(paths, data);
}

/** 读取阅读设置。 */
export async function readSettings(paths: StorePaths): Promise<WorkbenchData['settings']> {
  return (await loadData(paths)).settings;
}

/** 保存阅读设置（部分更新；同时记录最近打开的书）。 */
export async function saveSettings(
  paths: StorePaths,
  patch: SaveSettingsRequest,
): Promise<WorkbenchData['settings']> {
  const data = await loadData(paths);
  if (patch.reader !== undefined) {
    data.settings.reader = normalizeReaderSettings({ ...data.settings.reader, ...patch.reader });
  }
  if (patch.lastOpenedBookId !== undefined) {
    data.settings.lastOpenedBookId = patch.lastOpenedBookId === '' ? undefined : patch.lastOpenedBookId;
  }
  await saveData(paths, data);
  return data.settings;
}

/** 创建划线。 */
export async function createHighlight(
  paths: StorePaths,
  request: CreateHighlightRequest,
): Promise<Highlight> {
  const data = await loadData(paths);
  const highlight: Highlight = {
    id: newId(),
    bookId: request.bookId,
    text: request.text,
    note: request.note,
    anchor: request.anchor,
    createdAt: Date.now(),
  };
  data.highlights.push(highlight);
  await saveData(paths, data);
  return highlight;
}

/** 更新划线笔记（正文不可改，只允许 note；返回更新后的条目）。 */
export async function updateHighlightNote(
  paths: StorePaths,
  id: string,
  note: string,
): Promise<Highlight | undefined> {
  const data = await loadData(paths);
  const highlight = data.highlights.find((entry) => entry.id === id);
  if (highlight === undefined) return undefined;
  highlight.note = note.trim() === '' ? undefined : note;
  await saveData(paths, data);
  return highlight;
}

/** 删除划线。 */
export async function deleteHighlight(paths: StorePaths, id: string): Promise<boolean> {
  const data = await loadData(paths);
  const before = data.highlights.length;
  data.highlights = data.highlights.filter((h) => h.id !== id);
  if (data.highlights.length === before) return false;
  await saveData(paths, data);
  return true;
}

/**
 * 移除书目（不删原文件；顺带清理其划线与进度、书库副本与解压产物）。
 * 返回被移除的书籍条目，供调用方做后续处理（书库目录清理）。
 */
export async function removeBook(paths: StorePaths, id: string): Promise<Book | undefined> {
  const data = await loadData(paths);
  const book = data.books.find((entry) => entry.id === id);
  if (book === undefined) return undefined;
  data.books = data.books.filter((entry) => entry.id !== id);
  delete data.progress[id];
  data.highlights = data.highlights.filter((h) => h.bookId !== id);
  if (data.settings.lastOpenedBookId === id) delete data.settings.lastOpenedBookId;
  await saveData(paths, data);
  return book;
}

/** 清理书本在书库中的落盘产物（副本文件 / 解压目录）；原文件不动。 */
export async function purgeBookFiles(paths: StorePaths, book: Book): Promise<void> {
  const { rm } = await import('node:fs/promises');
  // 文本类：library/<id>.<format> 单文件；章节类：library/<id>/ 目录
  const copy = join(paths.libraryDir, book.id + '.' + book.format);
  contentCache.delete(copy);
  await rm(copy, { force: true });
  await rm(join(paths.libraryDir, book.id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 网页书源（format === 'web'）
//
// 落盘形态**照抄 mobi**：library/<id>/manifest.json + 单章 HTML。
// 这样 readEpubManifest（上方）、/content?chapter=n 的章节读取、
// /toc、safeZipPath 的路径穿越防护、purgeBookFiles 的目录清理全部零改动复用。
//
// 与 mobi 的差别只有两点：
// 1. 章节是**逐章增量写入**的（1221 章不可能一次抓完），所以要多一个 web.json 记录进度；
// 2. 目录可能因抓取后端的 10 万字符上限被截断，需要支持**目录懒扩展**（appendWebChapters）。
// ---------------------------------------------------------------------------

/** 网页书抓取状态文件名（与 manifest.json / cover.json 同层）。 */
const WEB_STATE_FILE = 'web.json';

/** 章节 HTML 在书目录下的子目录名。 */
const WEB_CHAPTERS_DIR = 'chapters';

/**
 * 章节 HTML 在书目录内的相对路径。
 * 固定 4 位零填充，保证目录里按文件名排序也是阅读顺序（便于人工排查）。
 * @param index - 章序（0 起）。
 */
export function webChapterHref(index: number): string {
  return `${WEB_CHAPTERS_DIR}/${String(index).padStart(4, '0')}.html`;
}

/**
 * 把纯文本转义成 HTML 文本节点。
 * 网页书**只存段落纯文本**，不保留原站任何标签/属性/脚本 ——
 * 否则注入面会从一个消毒点（客户端 sanitizeHtml）扩散到所有消费方（Agent 工具、未来的导出）。
 * @param text - 原始文本。
 */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 读网页书的抓取状态；文件缺失或损坏返回 undefined（调用方据此判定「不是网页书」）。 */
export async function readWebState(paths: StorePaths, book: Book): Promise<WebBookState | undefined> {
  try {
    const raw = await readFile(join(bookDir(paths, book), WEB_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as WebBookState;
    if (!Array.isArray(parsed.fetched) || !Array.isArray(parsed.errors)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 写网页书的抓取状态（原子写由 data.json 那套负责，这里状态文件允许直接覆盖）。 */
export async function writeWebState(paths: StorePaths, book: Book, state: WebBookState): Promise<void> {
  const dir = bookDir(paths, book);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, WEB_STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 建一本网页书：写 manifest + 空 web.json + 入库。
 *
 * **只建骨架不抓正文**：正文由 `fetchWebChapters` 逐章抓（1221 章要 30 分钟量级，
 * 不能塞进建书请求）。首章没抓到时阅读器会报「章节文件缺失」，
 * 因此调用方建书后应立刻抓 1 章再返回给 UI。
 *
 * @param paths - 存储路径。
 * @param meta - 书名、作者、入口 URL、站点、目录。
 */
export async function createWebBook(
  paths: StorePaths,
  meta: {
    title: string;
    author?: string;
    sourceUrl: string;
    siteId: string;
    chapters: WebChapterRef[];
  },
): Promise<Book> {
  const title = meta.title.trim();
  if (title === '') throw new Error('网页书书名不能为空');
  if (meta.chapters.length === 0) throw new Error('目录为空：没有解析到任何章节');
  const book: Book = {
    id: newId(),
    title,
    author: meta.author?.trim() || undefined,
    // 与上传通道的 `upload:<title>.<format>` 同构：网页书没有本地原文件，用伪路径标明来源
    sourcePath: `web:${meta.sourceUrl}`,
    format: 'web',
    addedAt: Date.now(),
    hasCover: false,
    source: 'web',
    sourceUrl: meta.sourceUrl,
    siteId: meta.siteId,
  };
  const dir = join(paths.libraryDir, book.id);
  await mkdir(join(dir, WEB_CHAPTERS_DIR), { recursive: true });
  const manifest: EpubManifest = {
    title: book.title,
    author: book.author,
    chapters: meta.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      href: webChapterHref(chapter.index),
    })),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeWebState(paths, book, {
    sourceUrl: meta.sourceUrl,
    siteId: meta.siteId,
    createdAt: Date.now(),
    total: meta.chapters.length,
    fetched: [],
    errors: [],
    urls: meta.chapters.map((chapter) => chapter.url),
  });
  const data = await loadData(paths);
  data.books.push(book);
  await saveData(paths, data);
  return book;
}

/** 写一章正文（`<p>` 包裹的纯文本）；已存在的章节文件直接覆盖（幂等）。 */
export async function writeWebChapter(
  paths: StorePaths,
  book: Book,
  chapter: WebChapterRef,
  paragraphs: string[],
): Promise<void> {
  const dir = bookDir(paths, book);
  await mkdir(join(dir, WEB_CHAPTERS_DIR), { recursive: true });
  const body = paragraphs.map((text) => `<p>${escapeHtmlText(text)}</p>`).join('\n');
  const html = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtmlText(chapter.title)}</title>`,
    '</head><body>',
    body,
    '</body></html>',
    '',
  ].join('\n');
  await writeFile(join(dir, webChapterHref(chapter.index)), html, 'utf8');
}

/**
 * 目录懒扩展：把新发现的章节追加到 manifest 与 web.json 的 total。
 *
 * 为什么需要：抓取后端单次只解码 100,000 字符，目标站目录页实测 135,879 字符会被截断，
 * 目录尾部章节拿不到。抓正文时正文页会给出「下一章」链接（`data-nurl`），
 * 于是抓完已知最后一章时顺手把下一章追加进目录，如此续爬到末章（`nextUrl` 为空）。
 *
 * @returns 追加后的实际总章数。
 */
export async function appendWebChapters(
  paths: StorePaths,
  book: Book,
  chapters: WebChapterRef[],
): Promise<number> {
  if (chapters.length === 0) return 0;
  const manifest = await readEpubManifest(paths, book);
  if (manifest === undefined) throw new Error('本书缺少 manifest.json，无法扩展目录');
  const state = await readWebState(paths, book);
  const knownUrls = new Set(state?.urls ?? []);
  // 去重：已经收录过的 URL 不再追加（防止章节链回环导致目录无限增长）
  const fresh = chapters.filter((chapter) => !knownUrls.has(chapter.url));
  if (fresh.length === 0) return manifest.chapters.length;
  const start = manifest.chapters.length;
  for (const [offset, chapter] of fresh.entries()) {
    manifest.chapters.push({
      // index 必须等于数组下标：/content?chapter=n 是按数组下标取的
      index: start + offset,
      title: chapter.title,
      href: webChapterHref(start + offset),
    });
  }
  await writeFile(join(bookDir(paths, book), 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (state !== undefined) {
    state.total = manifest.chapters.length;
    state.urls.push(...fresh.map((chapter) => chapter.url));
    await writeWebState(paths, book, state);
  }
  return manifest.chapters.length;
}

/**
 * 修正某一章的标题（目录懒扩展时先写入占位标题，抓到正文后再改成真实标题）。
 * @returns 是否找到该章。
 */
export async function updateWebChapterTitle(
  paths: StorePaths,
  book: Book,
  index: number,
  title: string,
): Promise<boolean> {
  const manifest = await readEpubManifest(paths, book);
  if (manifest === undefined) return false;
  const chapter = manifest.chapters[index];
  if (chapter === undefined) return false;
  if (chapter.title === title) return false;
  chapter.title = title;
  await writeFile(join(bookDir(paths, book), 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return true;
}

/** 更新书目条目上的网页书字段（如 `fetchedAt`）；找不到书返回 undefined。 */
export async function touchWebBook(
  paths: StorePaths,
  bookId: string,
  patch: { fetchedAt?: number },
): Promise<Book | undefined> {
  const data = await loadData(paths);
  const book = data.books.find((entry) => entry.id === bookId);
  if (book === undefined || book.source !== 'web') return undefined;
  if (patch.fetchedAt !== undefined) book.fetchedAt = patch.fetchedAt;
  await saveData(paths, data);
  return book;
}
