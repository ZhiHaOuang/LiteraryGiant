/**
 * 阅读工作台主面板：书架 ⇄ 阅读器 两态切换（UI v2）。
 *
 * 状态机很浅但很重要：
 * - `mode === 'shelf'`：封面网格；点书进入 `reader`；
 * - `mode === 'reader'`：整屏阅读（工具条只在顶部一行，正文最大化）；
 * - 打开器：从设置里读出的 `lastOpenedBookId` 决定启动落在哪一态。
 *
 * 数据流：本组件持有书目与设置，向下传 props；阅读器内部自己管分页与进度。
 *
 * 网页书源（2026-10-19）：抓取是**客户端驱动**的 —— Host 只提供「建书（目录 + 第 1 章）」
 * 「续抓 N 章」「查进度」三条路由，抓取节奏由本组件的轮询循环控制。这么设计的根因是
 * Host 半跑在 vm 沙箱里、没有计时器（agents.md §4.0），起不了后台任务。
 * 轮询状态与「是否在抓」分离（后者放在 ref 里）：暂停/卸载立刻生效，
 * 重进面板只要再问一次进度就能原地续上（进度本身在 Host 侧的 `web.json`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Book, BookWithState, ReaderSettings, WebSourceStatus } from '../../shared/types.ts';
import type { WorkbenchApi } from '../api.ts';
import type { WorkbenchKey } from '../locales.ts';
import { ShelfView, type WebJob } from './ShelfView.tsx';
import { ReaderView } from './ReaderView.tsx';

/** 组件依赖。 */
export interface WorkbenchPageProps {
  api: WorkbenchApi;
  /** 当前语言词典（由入口按 locale 选择）。 */
  t: (key: WorkbenchKey) => string;
}

/** 支持的文件扩展名判定。 */
const SUPPORTED = /\.(md|markdown|txt|html?|epub|mobi|pdf)$/i;

/** 默认阅读设置（Host 侧读不到时的兜底，与 store.ts 的默认值一致）。 */
const FALLBACK_SETTINGS: ReaderSettings = {
  fontSize: 17,
  lineHeight: 1.9,
  theme: 'follow',
  columns: 'auto',
  txtReflow: 'auto',
  bookCss: 'book',
  fontFamily: 'system',
};

/**
 * 网页书续抓的轮询间隔（毫秒）。
 *
 * 为什么是「客户端轮询」而不是 Host 后台任务：Host 半在 vm 沙箱里没有计时器
 * （`setTimeout`/`setInterval` 是 trap，见 agents.md §4.0），抓取节奏只能由请求往返驱动。
 *
 * **为什么是 1500ms 且每拍只抓 1 章**：站点实测（`docs/web-source/03-site-parsing.md` §5.4）
 * 给出的礼貌抓取纪律是「最小间隔 ≥1s，推荐 1.5~2s，单书顺序抓、不并发」。
 * 抓取本身还要 1~4s/章，所以稳态约 1 章/1.5s+ —— 1221 章约 40 分钟量级。
 * 曾经按 600ms/拍、渐进到每拍 5 章（≈8 章/秒）设计，那是在按站点限流阈值压测之前写的；
 * **快一倍换不来任何用户可感知的收益，却可能换来 IP 被封**，故回落到实测建议值。
 */
const WEB_POLL_INTERVAL_MS = 1500;

/**
 * 连续请求失败多少次才停下任务。
 *
 * 单次失败不打断：站点偶发 5xx / 超时很常见，一轮就放弃会让长书抓不完；
 * 连续 3 次失败则说明是结构性问题（路由未注册、网络断、站点挂），停下来把原因显示给用户。
 */
const WEB_MAX_CONSECUTIVE_FAILS = 3;

/**
 * 本次每步抓几章。
 *
 * **恒为 1**，理由见 `WEB_POLL_INTERVAL_MS` 的注释：站点实测的礼貌抓取纪律是
 * 「最小间隔 ≥1s、推荐 1.5~2s、顺序抓不并发」。曾经做过「连抓顺利就逐级上调到 5 章」的
 * 加速设计，但那等于在没有站点限流阈值数据的情况下压测，收益不可感知、封 IP 风险实在。
 * 保留这个函数而不是直接写 1，是为了将来有了站点限流数据后只改这一处。
 */
function chaptersPerStep(_steps: number): number {
  return 1;
}

/** 是否携带了可用的书名（空串/缺省一律视为「没给」）。 */
function exhibitsTitle(title: string | undefined): title is string {
  return typeof title === 'string' && title.trim() !== '';
}

/**
 * 进度卡排序：正在抓的在最上，其次按书名。
 *
 * 为什么需要排：任务可能是「刚刚新建的」或「进面板恢复出来的」，加入顺序不同，
 * 不排序会出现「恢复出来的老书压在新书上面」的观感。
 */
function sortWebJobs(jobs: WebJob[]): WebJob[] {
  return [...jobs].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

/** 面板根。 */
export function WorkbenchPage({ api, t }: WorkbenchPageProps) {
  const [books, setBooks] = useState<BookWithState[]>([]);
  const [settings, setSettings] = useState<ReaderSettings>(FALLBACK_SETTINGS);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 当前打开的书（undefined = 停在书架）。 */
  const [opened, setOpened] = useState<Book>();
  /** 网页书抓取任务（键为书目 id；顺序即展示顺序）。 */
  const [webJobs, setWebJobs] = useState<WebJob[]>([]);

  /**
   * 正在自动续抓的书目 id 集合（**用 ref 而不是 state**）：
   * 轮询循环的存活判定要读到「此刻」的值，state 在回调闭包里是快照。
   * 键消失 = 用户点了暂停 / 抓完了 / 书被移除。
   */
  const activeWebRef = useRef<Set<string>>(new Set());
  /** 轮询节拍器：自调度的 `setTimeout`（不用 interval，防止请求重叠）。 */
  const webTimerRef = useRef<number>(0);
  /** 组件是否已卸载（卸载后不再 setState，也不再发请求）。 */
  const mountedRef = useRef(true);
  /** 每个书目此刻是否有在途请求（防重叠：上一拍没回来就不再发）。 */
  const inflightRef = useRef<Set<string>>(new Set());
  /** 每个书目已连续成功的步数（决定每步章数，出错归零）。 */
  const stepCountRef = useRef<Map<string, number>>(new Map());
  /** 每个书目已连续请求失败的次数（网络抖动容忍；达到阈值才停下）。 */
  const failCountRef = useRef<Map<string, number>>(new Map());
  /** 进度卡是否需要按书名排序重绘（新增任务时置位）。 */
  const orderDirtyRef = useRef(false);
  /**
   * 「刷新书目」的稳定转发器。
   *
   * 为什么要多这一层：真正的 `refresh` 声明在文件靠后，而建书回调在它之前就要用到 ——
   * 直接引用会撞 TDZ（依赖数组与回调体都在 render 期求值）。
   * 用一个 ref 间接调用，既能先用后声明，又不在回调里引入不稳定依赖。
   */
  const refreshBooksRef = useRef<() => Promise<void>>(async () => {});
  /** 进面板恢复只做一次（每次挂载一次）。 */
  const restoredRef = useRef(false);
  /** 轮询循环的「代数」：暂停/卸载时自增，旧循环看到代数变了就自行退出。 */
  const webLoopGenRef = useRef(0);

  // ── 初始加载：书目 + 设置（并恢复上次打开的书）──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, saved] = await Promise.all([api.listBooks(), api.settings()]);
        if (cancelled) return;
        setBooks(list);
        setSettings(saved.reader);
        setError(undefined);
        // 恢复上次打开的书（书还在书架上时）
        const lastId = saved.lastOpenedBookId;
        if (lastId !== undefined) {
          const entry = list.find((item) => item.book.id === lastId);
          if (entry !== undefined) setOpened(entry.book);
        }
        // 网页书抓取进度恢复必须挂在这里而不是另起一个 effect：
        // 首次加载的书目只存在于本闭包变量里，另起 effect 会拿到空数组、
        // 然后被 restoredRef 永久挡掉，表现为「重进面板后进度卡不出现，也不会继续抓」。
        if (!cancelled) restoreWebJobs(list);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
    // restoreWebJobs 内部只用 ref 与 api，不随 books 变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /**
   * 卸载清理：停轮询、清活跃集合、标记已卸载。
   * 已发出的请求会自然返回，但响应处理看到 `mountedRef === false` 就丢弃，不会再 setState。
   */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeWebRef.current.clear();
      inflightRef.current.clear();
      webLoopGenRef.current += 1;
      if (webTimerRef.current !== 0) {
        window.clearTimeout(webTimerRef.current);
        webTimerRef.current = 0;
      }
    };
  }, []);

  // ── 网页书源：建书 → 续抓 → 进度卡 ────────────────────────────────────────
  //
  // 数据流：本组回调全部是**稳定引用**（只依赖 api / setState 与 ref），进度驱动靠
  // 一个自调度的 setTimeout 循环 + 请求回包里的 `WebSourceStatus` 快照。
  // 不把 `webJobs` 塞进回调依赖，是为了避免「每抓一步 → 回调换新 → 循环重启」的自激振荡
  // （上一版就是这么写的，会把轮询节奏搅乱并在暂停后仍多发一拍请求）。

  /** 把一次状态快照落到进度卡上（是否在抓由 `activeWebRef` 决定，不在这里改）。 */
  const applyWebStatus = useCallback((bookId: string, title: string, status: WebSourceStatus): void => {
    setWebJobs((current) => {
      const done = status.pending <= 0;
      const exists = current.some((job) => job.bookId === bookId);
      // 新增任务时把顺序标记置位：即使携带的书名是空串，也在这次 setState 里统一按顺序重排
      if (!exists) orderDirtyRef.current = true;
      // 书名：新加入时用传入值；已有任务保留原值（避免轮询把名字刷成空串）
      const keepTitle = exhibitsTitle(title) ? title : (current.find((job) => job.bookId === bookId)?.title ?? title);
      const next: WebJob = {
        bookId,
        title: keepTitle,
        total: status.total,
        fetched: status.fetched,
        errorCount: status.errors.length,
        active: done ? false : activeWebRef.current.has(bookId),
        done,
        started: done || stepCountRef.current.has(bookId),
      };
      const merged = exists
        ? current.map((job) => (job.bookId === bookId ? { ...job, ...next, error: job.error } : job))
        : [...current, next];
      if (!orderDirtyRef.current) return merged;
      orderDirtyRef.current = false;
      return sortWebJobs(merged);
    });
  }, []);

  /** 单独改某个任务的「进行中 / 错误」标记（不动计数，也不动顺序）。 */
  const patchWebJob = useCallback((bookId: string, patch: Partial<WebJob>): void => {
    setWebJobs((current) => current.map((job) => (job.bookId === bookId ? { ...job, ...patch } : job)));
  }, []);

  /**
   * 续抓一步：抓 `chaptersPerStep` 章（当前恒为 1 章）并回写进度。
   *
   * 两层错误分开处理：
   * - **章节级失败**（`status.errors`）：坏章跳过、继续抓后面的，界面只计数；
   * - **请求级失败**（网关 401 / 路由未注册 / 断网）：记到 `job.error`、把任务切成暂停态。
   *   Host 侧路由还没上线时，用户看到的是可读的中文错误 + 「继续」按钮，而不是白屏或静默。
   */
  const fetchWebStep = useCallback(
    async (bookId: string): Promise<void> => {
      if (inflightRef.current.has(bookId)) return;
      inflightRef.current.add(bookId);
      try {
        const steps = stepCountRef.current.get(bookId) ?? 0;
        const status = await api.fetchWebChapters(bookId, chaptersPerStep(steps));
        if (!mountedRef.current) return;
        stepCountRef.current.set(bookId, steps + 1);
        applyWebStatus(bookId, '', status);
        if (status.pending <= 0) {
          activeWebRef.current.delete(bookId);
          stepCountRef.current.delete(bookId);
        }
      } catch (cause) {
        if (!mountedRef.current) return;
        // 出错即降速（下一轮从 1 章重新试探），但**不立刻放弃**：
        // 单章站点偶发 5xx / 超时很常见，连续失败到 WEB_MAX_CONSECUTIVE_FAILS 才停，
        // 停下后界面显示原因 + 「继续」按钮，用户可手动再试。
        stepCountRef.current.delete(bookId);
        const fails = (failCountRef.current.get(bookId) ?? 0) + 1;
        failCountRef.current.set(bookId, fails);
        if (fails >= WEB_MAX_CONSECUTIVE_FAILS) {
          failCountRef.current.delete(bookId);
          activeWebRef.current.delete(bookId);
          patchWebJob(bookId, {
            active: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      } finally {
        inflightRef.current.delete(bookId);
      }
    },
    [api, applyWebStatus, patchWebJob],
  );

  /** 读一次抓取状态（建书后 / 进面板恢复时用）。 */
  const syncWebStatus = useCallback(
    async (bookId: string, title: string): Promise<WebSourceStatus | undefined> => {
      try {
        const status = await api.webSourceStatus(bookId);
        if (!mountedRef.current) return status;
        // 字段里没 pending 时（老 Host 半或异常快照）按「已抓完」处理，
        // 免得 undefined > 0 恒为 false 却又让任务永远停在「抓取中」。
        const pending = typeof status.pending === 'number' && Number.isFinite(status.pending)
          ? status.pending
          : Math.max(0, (status.total ?? 0) - (status.fetched ?? 0));
        if (pending > 0) activeWebRef.current.add(bookId);
        applyWebStatus(bookId, title, { ...status, pending });
        return status;
      } catch {
        // 状态查不到（例如书刚被移除 / 路由未注册）不致命：
        // 进度卡不出现或保留上一次快照，不覆盖用户的其它操作，更不做失败重试风暴
        return undefined;
      }
    },
    [api, applyWebStatus],
  );

  /**
   * 轮询循环（自调度 setTimeout）。
   *
   * 存活判据是 `activeWebRef` 而非 state：点「暂停」= 把 id 从集合里删掉，
   * 循环下一拍看到它不在集合里就跳过，**不需要取消令牌**；在途请求的响应回来时
   * 若已不在集合里也一律丢弃（`applyWebStatus` 会算成 `active:false`）。
   * 卸载时代数 +1，旧循环自行退出。
   */
  const runWebLoop = useCallback((): void => {
    const generation = webLoopGenRef.current;
    const schedule = (): void => {
      if (!mountedRef.current || generation !== webLoopGenRef.current) return;
      if (webTimerRef.current !== 0) window.clearTimeout(webTimerRef.current);
      webTimerRef.current = window.setTimeout(step, WEB_POLL_INTERVAL_MS);
    };
    const step = (): void => {
      webTimerRef.current = 0;
      if (!mountedRef.current || generation !== webLoopGenRef.current) return;
      const active = [...activeWebRef.current];
      if (active.length === 0) return; // 没有活跃任务：循环结束，闲置时零请求
      for (const bookId of active) void fetchWebStep(bookId);
      schedule();
    };
    // 立刻先跑一拍：建书后进度马上开始动，不用等一个间隔
    step();
  }, [fetchWebStep]);

  /**
   * 进面板恢复：找出所有 `source === 'web'` 且还有待抓章节的书，重建进度卡并继续抓。
   *
   * 进度本身在 Host 侧（`library/<id>/web.json`），客户端不持久化任何东西——
   * 重进面板/重启 GUI 后只要再问一次 `/sources/web/status` 就能原地续上。
   * 只做一次（`restoredRef`），避免每次刷新书目都把所有网页书重新拉一遍。
   */
  const restoreWebJobs = useCallback(
    (list: BookWithState[]): void => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      const webBooks = list.filter((entry) => entry.book.source === 'web').map((entry) => entry.book);
      if (webBooks.length === 0) return;
      void (async () => {
        let resumed = false;
        for (const book of webBooks) {
          const status = await syncWebStatus(book.id, book.title);
          if (status !== undefined && status.pending > 0) resumed = true;
        }
        if (resumed && mountedRef.current) runWebLoop();
      })();
    },
    [runWebLoop, syncWebStatus],
  );

  /** 启动自动续抓（用户点「继续」，或建完书）。 */
  const resumeWebJob = useCallback(
    (bookId: string): void => {
      activeWebRef.current.add(bookId);
      // 重试从慢档开始：上次失败过就不在同一个站点上继续按高速率打
      failCountRef.current.delete(bookId);
      stepCountRef.current.delete(bookId);
      patchWebJob(bookId, { active: true, done: false, error: undefined });
      runWebLoop();
    },
    [patchWebJob, runWebLoop],
  );

  /**
   * 暂停自动续抓：只停轮询、**不丢进度**。
   * 已抓章节都在 Host 侧，再点「继续」会从断点往后抓；离开面板（切进阅读器）也不会中断，
   * 只有关掉整个面板（组件卸载）才停。
   */
  const stopWebJob = useCallback((bookId: string): void => {
    activeWebRef.current.delete(bookId);
    setWebJobs((current) => current.map((job) => (job.bookId === bookId ? { ...job, active: false } : job)));
  }, []);

  /** 关闭进度卡（不删书、不动已抓内容）。 */
  const dismissWebJob = useCallback((bookId: string): void => {
    activeWebRef.current.delete(bookId);
    setWebJobs((current) => current.filter((job) => job.bookId !== bookId));
  }, []);

  /** 建网页书：抓目录 + 第 1 章，随后自动续抓。返回是否建书成功（失败时输入框保留 URL）。 */
  const addWebSource = useCallback(
    async (url: string): Promise<boolean> => {
      setError(undefined);
      setNotice(undefined);
      try {
        const book = await api.addWebSource(url);
        if (!mountedRef.current) return true;
        // 书目列表由「抓完即刷新」的 effect 兜底；这里不 await，避免建书后界面停顿
        void refreshBooksRef.current();
        // 先把进度卡摆出来（总数未知时进度条留在起点），再拉真实状态覆盖。
        // 排序标记在这里也置一次：本次 setState 的入参已经是排好的顺序，不会被二次打乱。
        activeWebRef.current.add(book.id);
        orderDirtyRef.current = true;
        setWebJobs((current) =>
          sortWebJobs([
            ...current.filter((job) => job.bookId !== book.id),
            { bookId: book.id, title: book.title, total: 0, fetched: 0, errorCount: 0, active: true, done: false, started: true },
          ]),
        );
        // 注意：这里不 await 状态查询再跑循环——建书本身就是一次长请求，
        // 后续进度由轮询补齐；状态查询失败也不影响抓取继续。
        void syncWebStatus(book.id, book.title).then(() => {
          if (activeWebRef.current.has(book.id) && mountedRef.current) runWebLoop();
        });
        setNotice(`${t('web.title')} · ${book.title}`);
        return true;
      } catch (cause) {
        if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [api, runWebLoop, syncWebStatus, t],
  );

  /**
   * 全部任务抓完后刷新一次书目：新抓的章节要进目录，书架进度也跟着更新。
   * 走 `refreshBooksRef`（而不是把 refresh 塞进依赖数组）：refresh 声明在本段之后，
   * 依赖数组在 render 期求值会撞 TDZ。
   */
  const finishedSignature = useMemo(
    () => webJobs.filter((job) => job.done).map((job) => `${job.bookId}:${job.fetched}`).join(','),
    [webJobs],
  );
  const lastFinishedRef = useRef('');
  useEffect(() => {
    if (finishedSignature === '' || finishedSignature === lastFinishedRef.current) return;
    lastFinishedRef.current = finishedSignature;
    void refreshBooksRef.current();
    // 稳定 ref，不进依赖数组（理由同上）
  }, [finishedSignature]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setBooks(await api.listBooks());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  /** 让上面的建书回调能调到「声明在后面」的 refresh。 */
  refreshBooksRef.current = refresh;

  /** 导入一组文件（选择器与拖拽共用）：文本走 JSON 通道，二进制走 octet-stream 通道。 */
  const importFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const list = Array.from(files).filter((file) => SUPPORTED.test(file.name));
      if (list.length === 0) {
        setError(t('import.unsupported'));
        return;
      }
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        for (const file of list) {
          if (/\.epub$/i.test(file.name)) {
            await api.uploadBinary(file, 'epub');
          } else if (/\.mobi$/i.test(file.name)) {
            await api.uploadBinary(file, 'mobi');
          } else if (/\.pdf$/i.test(file.name)) {
            await api.uploadBinary(file, 'pdf');
          } else {
            // 文本类同样传**原始字节**：绝不用 File.text() 先按 UTF-8 解码 ——
            // GBK 老书会在那一步被解成替换符，且损坏会被写进书库副本、永久固化
            // （2026-10-19 乱码事故根因）。编码判定统一放在 Host 侧。
            await api.uploadBinary(file, /\.(md|markdown)$/i.test(file.name) ? 'md' : 'txt');
          }
        }
        setNotice(`${t('import.done')}（${list.length}）`);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [api, refresh, t],
  );

  /** 打开书籍：切到阅读态并记住「最近打开」。 */
  const openBook = useCallback(
    (bookId: string): void => {
      const entry = books.find((item) => item.book.id === bookId);
      if (entry === undefined) return;
      setOpened(entry.book);
      setNotice(undefined);
      setError(undefined);
      void api.saveSettings({ lastOpenedBookId: bookId }).catch(() => {
        /* 记住位置失败无伤大雅 */
      });
    },
    [api, books],
  );

  /** 返回书架（保留 lastOpenedBookId，下次进来仍在原书）。 */
  const backToShelf = useCallback((): void => {
    setOpened(undefined);
    void refresh();
  }, [refresh]);

  /** 移除书目（不删原文件）。 */
  const removeBook = useCallback(
    async (bookId: string): Promise<void> => {
      try {
        await api.removeBook(bookId);
        if (opened?.id === bookId) setOpened(undefined);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, opened?.id, refresh],
  );

  /** 改阅读设置：先本地下发（UI 立即响应），再落盘。 */
  const changeSettings = useCallback(
    (patch: Partial<ReaderSettings>): void => {
      setSettings((current) => ({ ...current, ...patch }));
      void api
        .saveReaderSettings(patch)
        .then((saved) => setSettings(saved.reader))
        .catch(() => {
          /* 设置落盘失败：本地已生效，下次打开回落 */
        });
    },
    [api],
  );

  /** 当前打开的书对应的进度（重进阅读器时用于恢复)。 */
  const progress = useMemo(
    () => books.find((entry) => entry.book.id === opened?.id)?.progress,
    [books, opened?.id],
  );

  return (
    <div className="dsh-reading-view" data-dsh-plugin="reading-workbench" data-mode={opened === undefined ? 'shelf' : 'reader'}>
      {error !== undefined && <p className="dsh-reading-error dsh-reading-floating">{t('error.load')}: {error}</p>}
      {notice !== undefined && <p className="dsh-reading-notice dsh-reading-floating">{notice}</p>}

      {opened === undefined ? (
        <ShelfView
          api={api}
          t={t}
          books={books}
          busy={busy}
          dragging={dragging}
          onDragStateChange={setDragging}
          onImport={(files) => void importFiles(files)}
          onOpen={openBook}
          onRemove={(bookId) => void removeBook(bookId)}
          webJobs={webJobs}
          onAddWebSource={addWebSource}
          onResumeWebJob={resumeWebJob}
          onStopWebJob={stopWebJob}
          onDismissWebJob={dismissWebJob}
        />
      ) : (
        <ReaderView
          api={api}
          t={t}
          book={opened}
          settings={settings}
          progress={progress}
          onSettingsChange={changeSettings}
          onBack={backToShelf}
        />
      )}
    </div>
  );
}
