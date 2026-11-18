/**
 * Client API 封装：统一 fetch + 包络解包。
 *
 * 路径是 DOCUMENT-RELATIVE（不带前导斜杠）：GUI 以 `<base href="./">` 服务，
 * 子路径部署时 `/api/...` 会逃出部署前缀导致 404（skill-explorer issue #1707
 * 的同类结论）。字面量与 src/shared/types.ts 的 ROUTES 镜像，保持同步。
 */
import type {
  ApiResponse,
  Book,
  BookStylesPayload,
  BookWithState,
  CreateHighlightRequest,
  EpubChapter,
  FetchWebChaptersRequest,
  Highlight,
  ImportBookRequest,
  ImportWebRequest,
  ReaderSettings,
  SaveProgressRequest,
  SaveSettingsRequest,
  UploadBookRequest,
  WebSourceStatus,
  WorkbenchData,
} from '../shared/types.ts';
import { WEB_FETCH_MAX_PER_REQUEST } from '../shared/types.ts';

/** document-relative 路由表（与 host 侧 ROUTES 镜像）。 */
const API = {
  health: 'api/reading-workbench/health',
  books: 'api/reading-workbench/books',
  booksUpload: 'api/reading-workbench/books/upload',
  booksUploadBinary: 'api/reading-workbench/books/upload-binary',
  booksRemove: 'api/reading-workbench/books/remove',
  content: 'api/reading-workbench/content',
  toc: 'api/reading-workbench/toc',
  asset: 'api/reading-workbench/asset',
  styles: 'api/reading-workbench/styles',
  cover: 'api/reading-workbench/cover',
  file: 'api/reading-workbench/file',
  progress: 'api/reading-workbench/progress',
  settings: 'api/reading-workbench/settings',
  highlights: 'api/reading-workbench/highlights',
  highlight: 'api/reading-workbench/highlight',
  webSource: 'api/reading-workbench/sources/web',
  webSourceFetch: 'api/reading-workbench/sources/web/fetch',
  webSourceStatus: 'api/reading-workbench/sources/web/status',
} as const;

/**
 * 请求失败 / 包络失败统一抛错。
 * 注意：DSH 网关对未注册路由会返回非 JSON（401 文本），
 * 因此这里不能直接 `response.json()`——先取文本再尝试解析，
 * 否则用户看到的是 `Unexpected token 'o'` 这类无意义报错。
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  let body: ApiResponse<T> | undefined;
  try {
    body = JSON.parse(text) as ApiResponse<T>;
  } catch {
    // 网关层错误（未重启/未注册路由）：给出可行动的提示
    throw new Error(
      `HTTP ${response.status}${response.status === 401 ? '（插件路由未注册，重启 DSH 后生效）' : ''}`,
    );
  }
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

/** 阅读工作台 REST 客户端。 */
export class WorkbenchApi {
  /** 健康检查。 */
  health(): Promise<{ status: string }> {
    return request(API.health);
  }

  /** 书目列表（内嵌进度与划线数）。 */
  listBooks(): Promise<BookWithState[]> {
    return request(API.books);
  }

  /** 导入本地 md/txt（按绝对路径，Host 侧读文件）。 */
  importBook(requestBody: ImportBookRequest): Promise<Book> {
    return request(API.books, { method: 'POST', body: JSON.stringify(requestBody) });
  }

  /** 上传内容建书（**已废弃**：会丢掉原始字节，仅保留给老客户端兼容）。 */
  uploadBook(requestBody: UploadBookRequest): Promise<Book> {
    return request(API.booksUpload, { method: 'POST', body: JSON.stringify(requestBody) });
  }

  /**
   * 二进制上传建书（txt/md/epub/mobi/pdf）。
   *
   * 文本类也走这条通道：**编码判定必须拿到原始字节**。
   * `File.text()` 按规范只做 UTF-8 decode，GBK 文件会在浏览器里被解成替换符，
   * 再上传就把损坏固化了（2026-10-19 乱码事故的根因）。
   */
  async uploadBinary(file: File, format: 'txt' | 'md' | 'epub' | 'mobi' | 'pdf'): Promise<Book> {
    const title = file.name.replace(/\.(txt|md|markdown|epub|mobi|pdf|azw3)$/i, '') || file.name;
    const response = await fetch(`${API.booksUploadBinary}?title=${encodeURIComponent(title)}&format=${format}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
    const text = await response.text();
    let body: ApiResponse<Book>;
    try {
      body = JSON.parse(text) as ApiResponse<Book>;
    } catch {
      throw new Error(`HTTP ${response.status}（上传失败：网关未放行或路由未注册）`);
    }
    if (!body.ok) throw new Error(body.error);
    return body.data;
  }

  /** 移除书目。 */
  removeBook(bookId: string): Promise<{ removed: boolean }> {
    return request(API.booksRemove, { method: 'POST', body: JSON.stringify({ bookId }) });
  }

  /** 取书籍正文（文本类格式）。 */
  content(bookId: string): Promise<{ book: Book; content: string }> {
    return request(`${API.content}?id=${encodeURIComponent(bookId)}`);
  }

  /** 取章节书目录（epub/mobi）。 */
  toc(bookId: string): Promise<{ book: Book; chapters: EpubChapter[] }> {
    return request(`${API.toc}?id=${encodeURIComponent(bookId)}`);
  }

  /** 取单章 HTML（epub/mobi）。 */
  chapter(bookId: string, index: number): Promise<{ book: Book; chapter: EpubChapter; html: string; chapterCount: number }> {
    return request(`${API.content}?id=${encodeURIComponent(bookId)}&chapter=${index}`);
  }

  /** 书内资源 URL（图片/字体；/asset 是受围栏保护的 GET，直接给 img 标签用）。 */
  assetUrl(bookId: string, path: string): string {
    return `${API.asset}?bookId=${encodeURIComponent(bookId)}&path=${encodeURIComponent(path)}`;
  }

  /**
   * 书内样式表（epub 的 CSS 合并文本）。
   *
   * 返回 `css: ''` 表示**这本书没有书内样式**（mobi / web / 或整包无 CSS），
   * 属于正常结果，调用方应直接走统一美化；只有 reject 才是真的取不到。
   */
  bookStyles(bookId: string): Promise<BookStylesPayload> {
    return request(`${API.styles}?id=${encodeURIComponent(bookId)}`);
  }

  /**
   * 封面 URL。返回 URL 而不管是否存在——`<img onError>` 时客户端渲染生成式封面，
   * 避免为每本书先发一次 HEAD 探测。
   */
  coverUrl(bookId: string): string {
    return `${API.cover}?id=${encodeURIComponent(bookId)}`;
  }

  /** 原始书籍文件 URL（pdf.js 等二进制阅读器用）。 */
  fileUrl(bookId: string): string {
    return `${API.file}?id=${encodeURIComponent(bookId)}`;
  }

  /** 读设置（含最近打开的书与阅读器偏好）。 */
  settings(): Promise<WorkbenchData['settings']> {
    return request(API.settings);
  }

  /** 写设置（部分更新，返回合并后的完整设置）。 */
  saveSettings(patch: SaveSettingsRequest): Promise<WorkbenchData['settings']> {
    return request(API.settings, { method: 'PUT', body: JSON.stringify(patch) });
  }

  /** 便捷：只改阅读器设置。 */
  async saveReaderSettings(reader: Partial<ReaderSettings>): Promise<WorkbenchData['settings']> {
    return this.saveSettings({ reader });
  }

  /** 保存进度。 */
  saveProgress(requestBody: SaveProgressRequest): Promise<{ saved: boolean }> {
    return request(API.progress, { method: 'PUT', body: JSON.stringify(requestBody) });
  }

  /** 划线列表。 */
  listHighlights(bookId?: string): Promise<Highlight[]> {
    const suffix = bookId ? `?bookId=${encodeURIComponent(bookId)}` : '';
    return request(API.highlights + suffix);
  }

  /** 创建划线。 */
  createHighlight(requestBody: CreateHighlightRequest): Promise<Highlight> {
    return request(API.highlights, { method: 'POST', body: JSON.stringify(requestBody) });
  }

  /** 更新划线笔记（正文不可改；空串表示清除笔记）。 */
  updateHighlightNote(id: string, note: string): Promise<Highlight> {
    return request(`${API.highlight}?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    });
  }

  /** 删除划线。 */
  deleteHighlight(id: string): Promise<{ removed: boolean }> {
    return request(`${API.highlight}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ── 网页书源（format === 'web'）────────────────────────────────────────
  //
  // 三条路由都是「建书 → 续抓 → 查进度」的闭环：建书只抓目录 + 第 1 章，
  // 其余章节有两种到手方式：
  // 1. **后台续抓**：客户端反复调 `fetchWebChapters`（每请求最多
  //    `WEB_FETCH_MAX_PER_REQUEST` 章，避免单请求超时），轮询状态与中断由 UI 侧负责；
  // 2. **按需抓取**：读某一章时若本地还没有，Host 的 `/content?chapter=n` 会同步抓这一章
  //    再返回（1~4 秒，抓不到回 502 + 中文说明）。前端不必自己触发，只要把等待原因讲清楚。

  /**
   * 按网页书源建书（只抓目录 + 第 1 章）。
   * @param url - 书籍详情页或目录页 URL（由 Host 侧站点适配器判定）。
   * @returns 新建的书目条目（`format === 'web'`）。
   */
  addWebSource(url: string): Promise<Book> {
    const payload: ImportWebRequest = { url };
    return request(API.webSource, { method: 'POST', body: JSON.stringify(payload) });
  }

  /**
   * 续抓若干章（一次请求最多 `WEB_FETCH_MAX_PER_REQUEST` 章）。
   * @param bookId - 网页书 id。
   * @param count - 本次抓几章（缺省 1；超上限由本方法收敛）。
   * @returns 抓取之后的进度快照。
   */
  fetchWebChapters(
    bookId: string,
    count?: number,
  ): Promise<WebSourceStatus> {
    const wanted = Math.max(1, Math.min(WEB_FETCH_MAX_PER_REQUEST, Math.trunc(count ?? 1)));
    const payload: FetchWebChaptersRequest = { bookId, count: wanted };
    return request(API.webSourceFetch, { method: 'POST', body: JSON.stringify(payload) });
  }

  /**
   * 查网页书抓取进度（已抓 / 待抓 / 错误清单 + 已抓章序）。
   * 进面板时用它恢复进度——`pending > 0` 就继续续抓；
   * 阅读器用它给章节目录逐章标「已下载 / 未下载」（见 `fetchedIndexesOf`）。
   */
  webSourceStatus(bookId: string): Promise<WebSourceStatus> {
    return request(`${API.webSourceStatus}?id=${encodeURIComponent(bookId)}`);
  }
}

/**
 * 从状态响应里读「已抓章序」。
 *
 * ⚠️ 返回值的三态语义必须分清，调用方不得合并：
 * - `Set<number>`：明确知道哪些章已抓到本地（空 Set = 一章都还没抓）；
 * - `undefined`：**未知** —— 老 Host 产物还没返回 `fetchedIndexes`，或字段形状不对。
 *
 * 为什么不能把 `undefined` 当「空集合」处理：那会把已下载的章节全部标成未下载，
 * 用户据此以为书没抓下来，比不显示状态更误导。UI 在未知时应当整体不画状态标记。
 *
 * 入参按 `unknown` 形状读取（而不是直接信任 `WebSourceStatus` 的类型）：
 * 类型只在编译期保证，运行期要面对「前端已更新、Host 半未重启」这种真实版本错配。
 */
export function fetchedIndexesOf(status: WebSourceStatus | undefined): Set<number> | undefined {
  const raw = (status as { fetchedIndexes?: unknown } | undefined)?.fetchedIndexes;
  if (!Array.isArray(raw)) return undefined;
  const indexes = new Set<number>();
  for (const value of raw) {
    // 非法元素静默跳过：一个脏数据不该让整份状态作废
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) indexes.add(value);
  }
  return indexes;
}
