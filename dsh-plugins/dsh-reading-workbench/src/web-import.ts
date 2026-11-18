/**
 * 网页书源抓取编排：建书 → 按章续抓 → 目录懒扩展 → 状态查询。
 *
 * 为什么抓取是「前端轮询驱动的分片」而不是后台循环：
 * Host 沙箱里 `setTimeout` / `setInterval` 都是 trap（调用即抛），写不出后台定时循环；
 * 而 1221 章 × ≥1.5s ≈ 30 分钟，也不可能塞进一个 HTTP 请求。
 * 于是「每个请求抓 N 章」，节奏由请求往返天然提供，用户可随时中断、重进可接着抓。
 */
import {
  appendWebChapters,
  createWebBook,
  loadData,
  purgeBookFiles,
  readEpubManifest,
  readWebState,
  removeBook,
  touchWebBook,
  updateWebChapterTitle,
  writeWebChapter,
  writeWebState,
} from './store.ts';
import type { StorePaths } from './store.ts';
import type {
  Book,
  EpubManifest,
  WebBookState,
  WebChapterRef,
  WebSourceStatus,
} from './shared/types.ts';
import { WEB_FETCH_MAX_PER_REQUEST } from './shared/types.ts';
import type { FetchHtml, SiteAdapter } from './web-source.ts';
import { SITE_ADAPTERS, selectAdapter } from './web-source.ts';

/** 建书结果（`POST /sources/web` 的响应体）。 */
export interface ImportWebBookResult {
  book: Book;
  /** 目录总章数。 */
  total: number;
  /** 已抓章数（建书时通常为 1）。 */
  fetched: number;
  /** 待抓章数。 */
  pending: number;
  /** 建目录过程中值得告知用户的情况（如目录被截断）。 */
  warnings: string[];
}

/** 续抓结果（`POST /sources/web/fetch` 的响应体）。
 *
 * 刻意做成 `WebSourceStatus` 的**超集**：UI 既可以只读 `pending`/`errors` 决定下一拍，
 * 也可以直接拿它当最新状态刷新进度条，不必再发一次 status 请求。
 */
export interface FetchWebChaptersResult {
  bookId: string;
  /** 目录当前总章数（目录懒扩展后会变）。 */
  total: number;
  /** 已抓章数（累计）。 */
  fetchedTotal: number;
  /** 本次成功抓取并落盘的章数。 */
  fetched: number;
  /** 剩余待抓章数。 */
  pending: number;
  /** 当前累计的错误清单（不是本次新增，便于 UI 直接展示）。 */
  errors: Array<{ index: number; url: string; message: string }>;
  /** 最近一次抓取完成时间。 */
  fetchedAt?: number;
  /** 已抓章节的章序（升序）—— 供 UI 逐章标记「已下载 / 未下载」。 */
  fetchedIndexes: number[];
  /** 本次是否已经把目录扩展到末章（false 表示还有未知章节待顺链发现）。 */
  catalogComplete: boolean;
}

/** 把 web 服务的错误码翻成可行动的中文。 */
export function describeWebError(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const message = typeof raw?.message === 'string' ? raw.message : String(error);
  switch (code) {
    case 'WEB_PROVIDER_AMBIGUOUS':
      return '网页抓取后端未固定：当前同时存在多个可用的抓取提供方。请在 profile 的 cordis.patch.yml 里为 dsh-web 设置 fetchProvider: http（或设置环境变量 DSH_WEB_FETCH_PROVIDER=http）后重启 DSH。';
    case 'WEB_PROVIDER_UNAVAILABLE':
      return '没有可用的网页抓取后端（dsh-web 未装配抓取提供方）。可在 profile 的 cordis.patch.yml 里为 dsh-web 设置 fetchProvider: http。';
    case 'WEB_PROVIDER_CONFIGURED_MISSING':
      return '配置指定的网页抓取提供方没有注册（检查 dsh-web 的 fetchProvider 取值）。';
    case 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE':
      return '配置指定的网页抓取提供方当前不可用（例如缺少 API 凭据）。';
    case 'WEB_PROVIDER_CREDENTIAL_MISSING':
      return '网页抓取提供方缺少 API 凭据。';
    // 内置抓取通道的错误码（web-fetch-fallback.ts）
    case 'BUILTIN_FETCH_BLOCKED_HOST':
      return '该域名不在内置抓取通道的白名单里（目前只允许书源适配器声明支持的站点）。';
    case 'BUILTIN_FETCH_BLOCKED_SCHEME':
      return '只允许抓取 https 地址。';
    case 'BUILTIN_FETCH_UNSUPPORTED_ENCODING':
      return '目标返回了压缩内容，内置抓取通道无法处理。';
    case 'BUILTIN_FETCH_BAD_ENCODING':
      return '页面不是合法的 UTF-8，编码可能已变更，已中止以避免乱码入库。';
    case 'BUILTIN_FETCH_TOO_LARGE':
      return '页面体积超过内置抓取通道的上限。';
    case 'BUILTIN_FETCH_TIMEOUT':
      return '抓取超时（站点响应过慢或本机网络不通）。';
    case 'BUILTIN_FETCH_INVALID_URL':
      return 'URL 格式不合法。';
    case 'BUILTIN_FETCH_HTTP_ERROR':
      return '目标返回了非 2xx 状态码。';
    case 'BUILTIN_FETCH_REDIRECT_BLOCKED':
      return '页面跳转被拒绝（跨站跳转或跳转次数过多）。';
    case 'WEB_FETCH_TIMEOUT':
      return '抓取超时（站点响应过慢或本机网络不通）。';
    case 'WEB_BLOCKED_URL':
      return '目标地址被拒绝（只允许公网 http/https 地址）。';
    case 'WEB_FETCH_TOO_LARGE':
      return '页面体积超过抓取上限。';
    case 'WEB_UNSUPPORTED_CONTENT_TYPE':
      return '目标返回的内容类型或编码不受支持。';
    case 'WEB_REDIRECT_BLOCKED':
      return '页面跳转被拒绝（跨站跳转不被允许）。';
    case 'WEB_INVALID_URL':
      return 'URL 格式不合法。';
    case 'WEB_ABORTED':
      return '抓取被取消。';
    default:
      return message;
  }
}

/** 按站点标识找适配器；找不到时按入口 URL 再猜一次。 */
function resolveAdapter(siteId: string, sourceUrl: string): SiteAdapter {
  const byId = SITE_ADAPTERS.find((adapter) => adapter.id === siteId);
  if (byId !== undefined) return byId;
  const byUrl = selectAdapter(sourceUrl);
  if (byUrl !== undefined) return byUrl;
  throw new Error(`没有可用于站点「${siteId}」的抓取适配器`);
}

/** 把数量收敛到 `[1, WEB_FETCH_MAX_PER_REQUEST]`。 */
function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(WEB_FETCH_MAX_PER_REQUEST, Math.floor(count)));
}

/**
 * 建一本网页书：抓目录 → 写 manifest → 抓首章 → 入库。
 *
 * 首章抓取失败会**回滚**（删书目与目录），避免书架上出现一本打不开的空书。
 *
 * **目录截断的自动补救**：宿主 `http` provider 单次只解码 100,000 字符，而目标站目录页
 * 实测 135,879 字符 —— 直接用它会得到一本「947 章」的伪完整书（真实 1221 章）。
 * 因此当入口页 `truncated === true` 且调用方提供了 `supplement`（插件内置抓取器，
 * 不受该上限约束）时，**用 supplement 重抓一次入口页**，拿到完整目录再建书。
 *
 * @param paths - 存储路径。
 * @param fetchHtml - 抓取能力（Host 侧由 `ctx.web` 或内置抓取器提供）。
 * @param entryUrl - 用户填的入口 URL。
 * @param options - 可选：`supplement` 用于在被截断时重抓目录（无字符上限的通道）。
 */
export async function importWebBook(
  paths: StorePaths,
  fetchHtml: FetchHtml,
  entryUrl: string,
  options: { supplement?: FetchHtml } = {},
): Promise<ImportWebBookResult> {
  const normalized = entryUrl.trim();
  if (normalized === '') throw new Error('URL 不能为空');
  const adapter = selectAdapter(normalized);
  if (adapter === undefined) {
    throw new Error(
      '暂不支持该站点：目前只支持 alicesw.tw（可填入目录页 /other/chapters/id/<id>.html 或书籍页 /novel/<id>.html）',
    );
  }
  const entryPage = await fetchHtml(normalized);
  let catalog = await adapter.fetchCatalog(fetchHtml, normalized, entryPage);
  let warnings = [...catalog.warnings];

  // 目录被截断 ⇒ 换不受字符上限约束的通道重抓一次，避免建出一本「缺尾」的书
  if (entryPage.truncated && options.supplement !== undefined) {
    try {
      const fullPage = await options.supplement(normalized);
      const fullCatalog = await adapter.fetchCatalog(options.supplement, normalized, fullPage);
      if (fullCatalog.chapters.length > catalog.chapters.length) {
        // 补全成功后把「先按截断建书、其余靠懒扩展补齐」那条**过时**提示删掉，
        // 否则用户会同时看到「目录被截断」与「已补全为完整目录」两句自相矛盾的话
        warnings = warnings.filter((text) => !text.includes('随抓取逐章补齐'));
        warnings.push(
          `目录页原本被截断（只解析到 ${catalog.chapters.length} 章），已改用无字符上限的通道重抓，` +
            `得到完整目录 ${fullCatalog.chapters.length} 章`,
        );
        catalog = fullCatalog;
      }
    } catch (error) {
      // 补救失败不致命：仍可按截断目录建书（后续靠目录懒扩展补齐）
      warnings.push(`目录页被截断，尝试完整重抓失败（${describeWebError(error)}），将按已解析到的章节建书`);
    }
  }

  if (catalog.chapters.length === 0) {
    throw new Error('入口页没有解析到任何章节（站点结构可能已改版），已中止建书');
  }

  const book = await createWebBook(paths, {
    title: catalog.title,
    author: catalog.author,
    sourceUrl: normalized,
    siteId: catalog.siteId,
    chapters: catalog.chapters,
  });

  try {
    // 建完立刻抓首章：否则用户点进去会看到「章节文件缺失」
    await fetchWebChapters(paths, fetchHtml, book.id, 1);
  } catch (error) {
    // 回滚：不留一本没有任何正文的空书
    await removeBook(paths, book.id);
    await purgeBookFiles(paths, book).catch(() => undefined);
    throw error;
  }

  const state = await readWebState(paths, book);
  const total = state?.total ?? catalog.chapters.length;
  const fetched = state?.fetched.length ?? 0;
  const refreshed = await loadData(paths);
  const storedBook = refreshed.books.find((entry) => entry.id === book.id) ?? book;
  return { book: storedBook, total, fetched, pending: Math.max(0, total - fetched), warnings };
}

/** 一次抓取所需的全部上下文（多章共用，避免每章重复读盘）。 */
interface WebFetchContext {
  book: Book;
  state: WebBookState;
  adapter: SiteAdapter;
  manifest: EpubManifest;
}

/** 读并校验抓取上下文；任何一项缺失都抛可行动的中文错误。 */
async function loadWebFetchContext(paths: StorePaths, bookId: string): Promise<WebFetchContext> {
  const data = await loadData(paths);
  const book = data.books.find((entry) => entry.id === bookId);
  if (book === undefined) throw new Error('书目不存在');
  if (book.source !== 'web') throw new Error('这本书不是网页书');
  const state = await readWebState(paths, book);
  if (state === undefined) {
    throw new Error('抓取状态 web.json 缺失，请移除后重新添加该书源');
  }
  const adapter = resolveAdapter(state.siteId, state.sourceUrl);
  const manifest = await readEpubManifest(paths, book);
  if (manifest === undefined) throw new Error('本书缺少 manifest.json，请移除后重新添加该书源');
  return { book, state, adapter, manifest };
}

/**
 * 抓取给定的章序集合（**唯一**的抓取循环实现，按序续抓与按需抓单章共用）。
 *
 * 单章失败只记进 `state.errors`，不中断其余章；已抓进度**每章落一次盘**，
 * 所以用户中断/进程重启都不会丢已抓内容。
 *
 * @returns 本次成功抓下的章数。
 */
async function runFetchIndexes(
  paths: StorePaths,
  fetchHtml: FetchHtml,
  ctx: WebFetchContext,
  indexes: number[],
): Promise<number> {
  const { book, state, adapter, manifest } = ctx;
  let fetchedNow = 0;
  for (const index of indexes) {
    const url = state.urls[index];
    if (url === undefined) continue;
    const chapter: WebChapterRef = {
      index,
      title: manifest.chapters[index]?.title ?? `第 ${index + 1} 节`,
      url,
    };
    try {
      const body = await adapter.fetchChapter(fetchHtml, chapter);
      await writeWebChapter(paths, book, chapter, body.paragraphs);
      // 正文页的章名比目录更权威（目录里可能是懒扩展写入的占位标题）
      await updateWebChapterTitle(paths, book, index, body.title);
      if (!state.fetched.includes(index)) {
        state.fetched.push(index);
        state.fetched.sort((a, b) => a - b);
      }
      state.errors = state.errors.filter((entry) => entry.index !== index);
      fetchedNow += 1;

      // 先落盘已抓进度，再做目录扩展（扩展函数会自行读改写 web.json）
      await writeWebState(paths, book, state);
      if (body.nextUrl !== undefined && body.nextUrl !== '' && index === state.urls.length - 1) {
        const nextUrl = body.nextUrl;
        await appendWebChapters(paths, book, [
          { index: state.urls.length, title: `第 ${state.urls.length + 1} 节`, url: nextUrl },
        ]);
        const reloaded = await readWebState(paths, book);
        if (reloaded !== undefined) {
          state.total = reloaded.total;
          state.urls = reloaded.urls;
        }
      }
    } catch (error) {
      const message = describeWebError(error);
      const existing = state.errors.find((entry) => entry.index === index);
      if (existing === undefined) state.errors.push({ index, url, message });
      else existing.message = message;
      await writeWebState(paths, book, state);
    }
  }
  return fetchedNow;
}

/**
 * 按顺序续抓若干章。
 *
 * 幂等：已抓过的章序跳过（以 `web.json` 的 `fetched` 为准）。
 * 目录懒扩展：抓完当前最后一章且正文页给出「下一章」链接时，把下一章追加进目录，
 * 用来补齐被抓取后端 10 万字符上限截断掉的那部分目录。
 *
 * @param paths - 存储路径。
 * @param fetchHtml - 抓取能力。
 * @param bookId - 书目 id。
 * @param count - 本次抓几章（默认 1，最大 5）。
 */
export async function fetchWebChapters(
  paths: StorePaths,
  fetchHtml: FetchHtml,
  bookId: string,
  count?: number,
): Promise<FetchWebChaptersResult> {
  const ctx = await loadWebFetchContext(paths, bookId);
  const { book, state } = ctx;

  // 按序取「最小的若干未抓章」。真正的抓取循环在 runFetchIndexes 里，
  // 与「按需抓单章」共用同一份实现。
  const limit = clampCount(count);
  const already = new Set(state.fetched);
  const todo: number[] = [];
  for (let index = 0; index < state.urls.length && todo.length < limit; index += 1) {
    if (!already.has(index)) todo.push(index);
  }

  const fetchedNow = await runFetchIndexes(paths, fetchHtml, ctx, todo);
  if (state.fetched.length > 0 && (state.fetchedAt === undefined || fetchedNow > 0)) {
    state.fetchedAt = Date.now();
    await writeWebState(paths, book, state);
    await touchWebBook(paths, book.id, { fetchedAt: state.fetchedAt });
  }

  const total = state.total;
  const pending = Math.max(0, total - state.fetched.length);
  return {
    bookId: book.id,
    total,
    fetchedTotal: state.fetched.length,
    fetched: fetchedNow,
    pending,
    errors: state.errors,
    fetchedAt: state.fetchedAt ?? book.fetchedAt,
    fetchedIndexes: [...state.fetched],
    // 最后一章抓到了且它没有再给出「下一章」，才算目录来到末章
    catalogComplete: pending === 0,
  };
}

/**
 * **按需抓取指定的某一章**（阅读器点开一章、而它还没抓过时用）。
 *
 * 为什么需要单独一条入口：按序续抓对「用户想读第 500 章」这种场景无能为力
 * （得先把前面 499 章抓完）。而网页书的价值恰恰是**点到哪章读哪章** ——
 * 抓不到就现抓，而不是甩一句 `chapter file missing`。
 *
 * @param paths - 存储路径。
 * @param fetchHtml - 抓取能力。
 * @param bookId - 书目 id。
 * @param index - 章序（0 起）。
 * @returns 是否可用；失败时 `message` 是已中文化的可行动说明。
 */
export async function fetchWebChapterAt(
  paths: StorePaths,
  fetchHtml: FetchHtml,
  bookId: string,
  index: number,
): Promise<{ ok: boolean; message?: string }> {
  const ctx = await loadWebFetchContext(paths, bookId);
  const { book, state } = ctx;
  if (state.fetched.includes(index)) return { ok: true };
  if (!Number.isInteger(index) || index < 0 || index >= state.urls.length) {
    return { ok: false, message: `章序超出范围（0..${state.urls.length - 1}）` };
  }

  const fetchedNow = await runFetchIndexes(paths, fetchHtml, ctx, [index]);
  if (fetchedNow > 0) {
    state.fetchedAt = Date.now();
    await writeWebState(paths, book, state);
    await touchWebBook(paths, book.id, { fetchedAt: state.fetchedAt });
    return { ok: true };
  }
  const failure = state.errors.find((entry) => entry.index === index);
  return { ok: false, message: failure?.message ?? '抓取失败（原因未记录）' };
}

/**
 * 读抓取进度。
 * @param paths - 存储路径。
 * @param bookId - 书目 id。
 * @returns 进度；书不存在或不是网页书返回 undefined。
 */
export async function readWebStatus(paths: StorePaths, bookId: string): Promise<WebSourceStatus | undefined> {
  const data = await loadData(paths);
  const book = data.books.find((entry) => entry.id === bookId);
  if (book === undefined || book.source !== 'web') return undefined;
  const state = await readWebState(paths, book);
  if (state === undefined) return undefined;
  const total = state.total;
  const fetched = state.fetched.length;
  return {
    bookId: book.id,
    total,
    fetched,
    pending: Math.max(0, total - fetched),
    errors: state.errors,
    fetchedAt: state.fetchedAt ?? book.fetchedAt,
    fetchedIndexes: [...state.fetched],
  };
}
