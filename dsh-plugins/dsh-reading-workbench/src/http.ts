/**
 * Host REST 路由族 /api/reading-workbench/*。
 * 全部 exact 路由 + query/body 传参（对齐 skill-explorer 实证形态）。
 * 信任围栏：loopback-only —— socket 地址 + Host 头 + 浏览器同源标记，
 * 不信任 X-Forwarded-For（对齐 dsh-web-shared/host/loopback 语义）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import {
  ROUTES,
  isChapteredFormat,
  type ApiResponse,
  type Book,
  type BookWithState,
  type CreateHighlightRequest,
  type FetchWebChaptersRequest,
  type ImportBookRequest,
  type ImportWebRequest,
  type SaveProgressRequest,
  type SaveSettingsRequest,
  type UploadBookRequest,
} from './shared/types.ts';
import {
  createHighlight,
  bookDir,
  deleteHighlight,
  importBook,
  importBookFromBinary,
  importBookFromContent,
  importTextBookFromBytes,
  loadData,
  purgeBookFiles,
  readBookContent,
  readEpubManifest,
  readSettings,
  removeBook,
  resolveStorePaths,
  saveData,
  saveProgress,
  saveSettings,
  updateHighlightNote,
  type StorePaths,
} from './store.ts';
import { ensureBookCover, readCover } from './cover.ts';
import { collectBookStyles } from './book-styles.ts';
import { safeZipPath } from './epub.ts';
import { describeWebError, fetchWebChapterAt, fetchWebChapters, importWebBook, readWebStatus } from './web-import.ts';
import type { FetchHtml } from './web-source.ts';

/** 判断是否 IPv4 127/8。 */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  return parts[0] === '127';
}

/** 规范化 socket 远端地址（去 IPv6 映射前缀与端口）。 */
function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  let value = address;
  // IPv4-mapped IPv6：::ffff:127.0.0.1
  if (value.startsWith('::ffff:')) value = value.slice(7);
  // [::1]:port 形态
  const bracket = value.lastIndexOf(']');
  if (bracket !== -1) return value.slice(1, bracket);
  // 127.0.0.1:port 形态（只有一个冒号时才当作端口分隔）
  const colon = value.lastIndexOf(':');
  if (colon !== -1 && value.indexOf(':') === colon) value = value.slice(0, colon);
  return value;
}

/** socket 地址是否 loopback（RFC 5735 127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  const value = normalizeAddress(address);
  if (!value) return false;
  if (value === '::1') return true;
  return isIPv4Loopback(value);
}

/** Host 名是否 loopback 权威（localhost、[::1]、127/8）。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

/**
 * 请求级信任围栏（语义对齐 skill-explorer 的 isLoopbackRequest，实证可用）：
 * 1) socket 远端地址必须 loopback（权威，不信任 X-Forwarded-For）；
 * 2) Host 头必须是 loopback 权威（用 URL 解析，兼容 [::1]:port 形态）；
 * 3) 明确 cross-site 的浏览器请求拒绝；带 Origin 时要求与 Host 头同源，
 *    没带 Origin（非浏览器客户端）则放行——socket + Host 已经验过。
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * 写 JSON 响应。
 *
 * 注意：Host 半在 DSH 的 vm 沙箱里执行，沙箱**没有 `Buffer`**（它不是被 trap 的
 * 函数型全局，取值为 undefined）。这里用 TextEncoder 数 UTF-8 字节数，别用
 * `Buffer.byteLength`——那会让所有路由在第一次响应时抛 ReferenceError。
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': utf8Length(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** UTF-8 字节数（替代沙箱里不可用的 `Buffer.byteLength`）。 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 成功包络。 */
function ok<T>(res: ServerResponse, data: T): void {
  writeJson(res, 200, { ok: true, data } satisfies ApiResponse<T>);
}

/** 失败包络。 */
function fail(res: ServerResponse, status: number, error: string): void {
  writeJson(res, status, { ok: false, error } satisfies ApiResponse<never>);
}

/**
 * 读请求体（限制 16MB：文本类上传导入要容纳整本书）。
 * 返回 `Uint8Array` 而不是 `Buffer`：沙箱里没有 `Buffer`，只有 TextEncoder/TextDecoder。
 * @param req - HTTP 请求对象（异步可迭代出数据块）。
 * @param limit - 最大字节数。
 * @returns 拼好的请求体字节。
 */
async function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > limit) throw new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
    chunks.push(bytes);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const bytes of chunks) {
    merged.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return merged;
}

/** 读 JSON 请求体。 */
async function readJsonBody(req: IncomingMessage, limit?: number): Promise<unknown> {
  const raw = new TextDecoder().decode(await readBody(req, limit));
  if (raw.trim() === '') return {};
  return JSON.parse(raw) as unknown;
}

/** 写二进制响应（资源与封面）。 */
function writeBinary(res: ServerResponse, contentType: string, data: Uint8Array, cacheable = true): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': data.byteLength,
    'cache-control': cacheable ? 'private, max-age=86400' : 'no-store',
  });
  res.end(data);
}

/** 按扩展名猜资源 Content-Type（书内静态资源够用）。 */
function assetContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',
    json: 'application/json; charset=utf-8',
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
    mobi: 'application/x-mobipocket-ebook',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** query 参数读取。 */
function queryParam(url: string, name: string): string | undefined {
  const value = new URL(url, 'http://x').searchParams.get(name);
  return value === null ? undefined : value;
}

/** 路由依赖（测试可注入假件）。 */
export interface RouteDeps {
  paths: StorePaths;
  logger: { warn(error: unknown): void };
  /**
   * 网页抓取能力。Host 侧由 `ctx.web.fetch` 或内置抓取器提供；**未注入时网页书源路由返回 501**，
   * 其余路由不受影响（与 `tools` 的降级策略一致：少一个功能，不拖垮整个插件）。
   * 单测里可以注入假的抓取函数，从而完全不依赖网络。
   */
  fetchHtml?: FetchHtml;
  /**
   * 不受 provider 字符上限约束的**补充**抓取通道（插件内置抓取器）。
   *
   * 只用于「目录页被抓取后端截断」时重抓一次完整目录 —— 宿主 `http` provider 单次只解码
   * 100,000 字符，而目标站目录页 135,879 字符，直接用它建书会得到一本缺尾的书。
   */
  supplementFetchHtml?: FetchHtml;
}

/** 组合守卫：围栏 + 方法检查；通过返回 true，否则已写响应。 */
function guard(req: IncomingMessage, res: ServerResponse, method: string, deps: RouteDeps): boolean {
  if (!isLoopbackRequest(req)) {
    fail(res, 403, 'forbidden: loopback-only');
    return false;
  }
  if (req.method !== method) {
    fail(res, 405, `method not allowed: ${req.method}`);
    return false;
  }
  return true;
}

/** 错误统一落日志并回 500/400。 */
function handleError(res: ServerResponse, deps: RouteDeps, error: unknown, status = 500): void {
  deps.logger.warn(error);
  fail(res, status, error instanceof Error ? error.message : String(error));
}

/**
 * 抓取服务缺失时的提示。
 * 这不是「抓取失败」，而是「本实例没有装配 web 抓取能力」——必须让用户看出区别，
 * 否则会误以为是站点或网络问题。
 */
const WEB_FETCH_UNAVAILABLE =
  '网页抓取服务（ctx.web）在本实例不可用：请在 DSH 中启用 web 服务后重启。书架、本地导入与阅读不受影响。';

/**
 * 老书目补探测封面：`hasCover` 字段是 UI v2 新增的，
 * 早于本次升级导入的 epub/mobi 没有该字段 —— 首次列书架时补一次并落盘。
 * @returns 是否有书籍条目被改动（调用方决定是否 saveData）
 */
async function backfillCovers(
  deps: RouteDeps,
  data: { books: Array<{ id: string; format: string; hasCover?: boolean; title: string; sourcePath: string; addedAt: number }> },
): Promise<boolean> {
  let changed = false;
  for (const book of data.books) {
    if (book.hasCover !== undefined) continue;
    if (!isChapteredFormat(book.format as never)) {
      book.hasCover = false;
      changed = true;
      continue;
    }
    try {
      // 类型上 backfill 只需要 id/format/libraryDir 这几个字段
      book.hasCover = await ensureBookCover(deps.paths, book as never);
    } catch {
      book.hasCover = false;
    }
    changed = true;
  }
  return changed;
}

/** 构建全部路由（ctx.webServer.register 的输入）。 */
export function makeRoutes(deps: RouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (_req, res) => {
        ok(res, { status: 'ok' });
      },
    },
    {
      kind: 'exact',
      path: ROUTES.books,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET', deps)) return;
          try {
            const data = await loadData(deps.paths);
            const changed = await backfillCovers(deps, data);
            if (changed) await saveData(deps.paths, data);
            const payload: BookWithState[] = data.books.map((book) => ({
              book,
              progress: data.progress[book.id],
              highlightCount: data.highlights.filter((h) => h.bookId === book.id).length,
            }));
            ok(res, payload);
          } catch (error) {
            handleError(res, deps, error);
          }
          return;
        }
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as ImportBookRequest;
          // 按路径导入：读**原始字节**交给导入层判定编码（不要在这里先按 utf8 解码）
          const book = await importBook(deps.paths, body, (path) => readFile(path));
          ok(res, book);
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.booksUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as UploadBookRequest;
          if (typeof body.title !== 'string' || typeof body.content !== 'string') {
            fail(res, 400, 'expected { title, format, content }');
            return;
          }
          const book = await importBookFromContent(deps.paths, body);
          ok(res, book);
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.booksRemove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as { bookId?: string };
          if (typeof body.bookId !== 'string' || body.bookId === '') {
            fail(res, 400, 'expected { bookId }');
            return;
          }
          const removed = await removeBook(deps.paths, body.bookId);
          if (removed === undefined) {
            fail(res, 404, 'book not found');
            return;
          }
          // 书库副本与解压产物一并清理（原文件不动）
          await purgeBookFiles(deps.paths, removed).catch((error: unknown) => deps.logger.warn(error));
          ok(res, { removed: true });
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    // ---- 网页书源（format === 'web'） ----
    {
      kind: 'exact',
      path: ROUTES.webSource,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as ImportWebRequest;
          if (typeof body.url !== 'string' || body.url.trim() === '') {
            fail(res, 400, 'expected { url }');
            return;
          }
          if (deps.fetchHtml === undefined) {
            fail(res, 501, WEB_FETCH_UNAVAILABLE);
            return;
          }
          const result = await importWebBook(deps.paths, deps.fetchHtml, body.url, {
            supplement: deps.supplementFetchHtml,
          });
          ok(res, result);
        } catch (error) {
          // 抓取失败的 code 必须翻成可行动的中文（用户要求：工具自身出错要显式报错，不能报通过）
          deps.logger.warn(error);
          fail(res, 400, describeWebError(error));
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.webSourceFetch,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as FetchWebChaptersRequest;
          if (typeof body.bookId !== 'string' || body.bookId === '') {
            fail(res, 400, 'expected { bookId, count? }');
            return;
          }
          if (deps.fetchHtml === undefined) {
            fail(res, 501, WEB_FETCH_UNAVAILABLE);
            return;
          }
          const result = await fetchWebChapters(deps.paths, deps.fetchHtml, body.bookId, body.count);
          ok(res, result);
        } catch (error) {
          deps.logger.warn(error);
          fail(res, 400, describeWebError(error));
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.webSourceStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const status = await readWebStatus(deps.paths, id);
          if (status === undefined) {
            fail(res, 404, '不是网页书，或抓取状态丢失');
            return;
          }
          ok(res, status);
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.cover,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === id);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          const cover = await readCover(deps.paths, book);
          if (cover === undefined) {
            // 无封面是正常状态：客户端据此渲染生成式封面
            fail(res, 404, 'no cover');
            return;
          }
          writeBinary(res, cover.contentType, cover.bytes);
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.settings,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET', deps)) return;
          try {
            ok(res, await readSettings(deps.paths));
          } catch (error) {
            handleError(res, deps, error);
          }
          return;
        }
        if (!guard(req, res, 'PUT', deps)) return;
        try {
          const body = (await readJsonBody(req)) as SaveSettingsRequest;
          if (body.reader !== undefined && (typeof body.reader !== 'object' || body.reader === null)) {
            fail(res, 400, 'expected { reader?, lastOpenedBookId? }');
            return;
          }
          ok(res, await saveSettings(deps.paths, body));
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.content,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const url = req.url ?? '/';
          const id = queryParam(url, 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === id);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          // 章节书（epub/mobi/web）：?chapter=n 按章返回（章节 HTML + 章节总数），无 chapter 返回目录信息
          if (isChapteredFormat(book.format)) {
            const manifest = await readEpubManifest(deps.paths, book);
            if (manifest === undefined) {
              fail(res, 409, 'book manifest missing (import may have failed)');
              return;
            }
            const chapterParam = queryParam(url, 'chapter');
            if (chapterParam === undefined) {
              ok(res, { book, manifest });
              return;
            }
            const chapterIndex = Number(chapterParam);
            if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= manifest.chapters.length) {
              fail(res, 400, `chapter out of range: 0..${manifest.chapters.length - 1}`);
              return;
            }
            const chapter = manifest.chapters[chapterIndex]!;
            const dir = bookDir(deps.paths, book);
            const target = safeZipPath(dir, chapter.href);
            if (target === undefined) {
              fail(res, 400, 'invalid chapter path');
              return;
            }
            let html: string | undefined;
            try {
              html = await readFile(target, 'utf8');
            } catch {
              html = undefined;
            }
            if (html === undefined && book.source === 'web') {
              // 网页书：这一章还没抓过 ⇒ **现在就抓**，而不是回 404。
              //
              // 这是网页书「点到哪章读哪章」的关键：按序续抓对「用户想读第 500 章」
              // 无能为力（得先把前 499 章抓完）。抓取耗时 1~4 秒，前端会显示加载态。
              if (deps.fetchHtml === undefined) {
                fail(res, 501, WEB_FETCH_UNAVAILABLE);
                return;
              }
              const fetched = await fetchWebChapterAt(deps.paths, deps.fetchHtml, book.id, chapterIndex);
              if (!fetched.ok) {
                fail(res, 502, `本章尚未抓取，即时抓取也未成功：${fetched.message ?? '原因未知'}`);
                return;
              }
              try {
                html = await readFile(target, 'utf8');
              } catch {
                fail(res, 500, '已抓取本章但章节文件仍不可读，请重试');
                return;
              }
            }
            if (html === undefined) {
              fail(res, 404, 'chapter file missing');
              return;
            }
            ok(res, { book, chapter, html, chapterCount: manifest.chapters.length });
            return;
          }
          const content = await readBookContent(deps.paths, book, (path) => readFile(path, 'utf8'));
          ok(res, { book, content });
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.toc,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === id);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          const manifest = await readEpubManifest(deps.paths, book);
          if (manifest === undefined) {
            fail(res, 409, 'book manifest missing (not a chapter-based book or import failed)');
            return;
          }
          ok(res, { book, chapters: manifest.chapters });
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.asset,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const bookId = queryParam(req.url ?? '/', 'bookId');
          const path = queryParam(req.url ?? '/', 'path');
          if (!bookId || !path) {
            fail(res, 400, 'expected ?bookId=<id>&path=<zip-relative-path>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === bookId);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          // 路径穿越防护：resolve 后必须仍落在该书目录内
          const target = safeZipPath(bookDir(deps.paths, book), path);
          if (target === undefined) {
            fail(res, 400, 'invalid asset path');
            return;
          }
          const bytes = await readFile(target);
          writeBinary(res, assetContentType(path), bytes);
        } catch {
          fail(res, 404, 'asset not found');
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.styles,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === id);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          const payload = await collectBookStyles(bookDir(deps.paths, book), book.format);
          ok(res, payload);
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.file,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<bookId>');
            return;
          }
          const data = await loadData(deps.paths);
          const book = data.books.find((b) => b.id === id);
          if (!book) {
            fail(res, 404, 'book not found');
            return;
          }
          // 网页书没有「整本二进制」：正文是本地章节快照，应走 /content?chapter=n。
          // 若落到下面的文本分支会去读 library/<id>.web 并报一个看不懂的 ENOENT。
          if (book.format === 'web') {
            fail(res, 409, '网页书没有整本文件，请用 /content?chapter=n 逐章读取');
            return;
          }
          // 二进制原样返回：epub/mobi/pdf 走书库副本，文本类回落原文件
          let bytes: Uint8Array;
          if (book.format === 'epub' || book.format === 'mobi' || book.format === 'pdf') {
            bytes = await readFile(join(bookDir(deps.paths, book), 'book.' + book.format));
          } else {
            bytes = new TextEncoder().encode(await readBookContent(deps.paths, book, (path) => readFile(path, 'utf8')));
          }
          writeBinary(res, assetContentType('book.' + book.format), bytes);
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.booksUploadBinary,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const url = req.url ?? '/';
          const title = queryParam(url, 'title');
          const format = queryParam(url, 'format');
          // 文本类（txt/md）走同一通道：**编码判定必须发生在拿到原始字节的这一层**，
          // 客户端不再用 File.text() 先按 UTF-8 解码（那是 GBK 乱码事故的源头）。
          const isText = format === 'txt' || format === 'md';
          if (!title || (!isText && format !== 'epub' && format !== 'mobi' && format !== 'pdf')) {
            fail(res, 400, 'expected ?title=<name>&format=<txt|md|epub|mobi|pdf>');
            return;
          }
          const bytes = await readBody(req, 128 * 1024 * 1024);
          const author = queryParam(url, 'author');
          let book: Book;
          if (format === 'txt' || format === 'md') {
            book = await importTextBookFromBytes(
              deps.paths,
              { title, format, author, sourcePath: `upload:${title}.${format}` },
              bytes,
            );
          } else {
            book = await importBookFromBinary(
              deps.paths,
              { title, format: format as 'epub' | 'mobi' | 'pdf', author },
              bytes,
            );
          }
          ok(res, book);
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.progress,
      handler: async (req, res) => {
        if (!guard(req, res, 'PUT', deps)) return;
        try {
          const body = (await readJsonBody(req)) as SaveProgressRequest;
          if (typeof body.bookId !== 'string' || typeof body.anchor !== 'string' || typeof body.percent !== 'number') {
            fail(res, 400, 'expected { bookId, anchor, percent }');
            return;
          }
          await saveProgress(deps.paths, body.bookId, body.anchor, body.percent);
          ok(res, { saved: true });
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.highlights,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET', deps)) return;
          try {
            const bookId = queryParam(req.url ?? '/', 'bookId');
            const data = await loadData(deps.paths);
            const list = bookId ? data.highlights.filter((h) => h.bookId === bookId) : data.highlights;
            ok(res, list);
          } catch (error) {
            handleError(res, deps, error);
          }
          return;
        }
        if (!guard(req, res, 'POST', deps)) return;
        try {
          const body = (await readJsonBody(req)) as CreateHighlightRequest;
          if (typeof body.bookId !== 'string' || typeof body.text !== 'string' || typeof body.anchor !== 'string') {
            fail(res, 400, 'expected { bookId, text, anchor, note? }');
            return;
          }
          const created = await createHighlight(deps.paths, body);
          ok(res, created);
        } catch (error) {
          handleError(res, deps, error, 400);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.highlight,
      handler: async (req, res) => {
        // PATCH：更新划线笔记（正文不可改，只允许 note）
        if (req.method === 'PATCH') {
          if (!guard(req, res, 'PATCH', deps)) return;
          try {
            const id = queryParam(req.url ?? '/', 'id');
            if (!id) {
              fail(res, 400, 'expected ?id=<highlightId>');
              return;
            }
            const body = (await readJsonBody(req)) as { note?: string };
            if (typeof body.note !== 'string') {
              fail(res, 400, 'expected { note: string }');
              return;
            }
            const updated = await updateHighlightNote(deps.paths, id, body.note);
            if (updated === undefined) {
              fail(res, 404, 'highlight not found');
              return;
            }
            ok(res, updated);
          } catch (error) {
            handleError(res, deps, error, 400);
          }
          return;
        }
        if (!guard(req, res, 'DELETE', deps)) return;
        try {
          const id = queryParam(req.url ?? '/', 'id');
          if (!id) {
            fail(res, 400, 'expected ?id=<highlightId>');
            return;
          }
          const removed = await deleteHighlight(deps.paths, id);
          if (removed) ok(res, { removed: true });
          else fail(res, 404, 'highlight not found');
        } catch (error) {
          handleError(res, deps, error);
        }
      },
    },
  ];
}
