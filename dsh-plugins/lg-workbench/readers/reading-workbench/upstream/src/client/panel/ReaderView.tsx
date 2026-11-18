/**
 * 阅读器：把「书」渲染成分页版面，并负责翻页/进度/版式设置。
 *
 * 三种书的统一模型（unit = 可翻页的单元）：
 * - 章节书 epub/mobi：unit = 章节（章内再分屏）；跨章翻页由本组件调度；
 * - 文本类 md/txt/html：unit = 整本（一次取全文，整体分屏）；
 *   **txt 例外**：整本作为一个排版单元会把 55 万字一次排成几百列（打开卡顿），
 *   因此 txt 由 `splitTextUnits` 切成若干虚拟单元，一次只渲染一个
 *   （见 ../txt-units.ts 的说明与偏移契约）；
 * - pdf：unit = PDF 页（交给 PdfViewer，本组件只提供工具条与设置）。
 *
 * 网页书（format === 'web'，2026-10-19 可读性修复）：
 * 复用章节书链路，但章节文件是**按需**从原站抓下来的 —— 目录里只有第 1 章和后台续抓到的那些，
 * 其余章节点开时由 Host 同步抓取（1~4 秒，抓不到回 502 + 中文说明）。因此本组件要：
 * 1. 进阅读器查一次 `/sources/web/status`，用 `fetchedIndexes` 给目录逐章标 ✓ 已下载 / ↓ 未下载；
 * 2. 加载态说明「正在抓取本章…」，失败给「错误原文 + 重试」而不是让「加载中…」空转；
 * 3. 状态未知（老 Host 产物没返回 `fetchedIndexes`）时整份标记不画，绝不退化成「全部未下载」。
 * 以上都只在 `isWeb` 时生效，epub/mobi 的行为一个字符都不变。
 *
 * ⚠️ TXT 的两套偏移（本轮改造重点，动这里之前先读这段）：
 * - **原文偏移**：入库锚点（`mark:off=…`）与 `textContent` 上的偏移，基数是全书；
 * - **渲染偏移**：DOM 里的偏移。TXT 正文由 `layoutTxt` 生成（合并折行、剥段首缩进、
 *   每段一个 `<p>`），DOM 文本**不等于**原文，两者必须显式换算：
 *   创建划线走 `renderToFull`，恢复高亮 / 笔记栏定位走 `fullToRender`，
 *   长度一律「端点相减」换算 —— 少一处不会报错，只会让划线静默错位或偏短。
 * - HTML 转义必须用 `txt-layout.ts` 的 `escapeHtmlText`，不可在本文件另留一份：
 *   两份实现一旦漂移，「DOM 文本 === renderText」这条等式就断了，全部偏移一起失效。
 *
 * 进度锚点同时记「页」与「百分比」（见 shared/anchor.ts）：页码在同一视口下精确，
 * 百分比在换视口重排后仍然可用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Book, ReaderSettings, ReadingProgress, EpubChapter, Highlight } from '../../shared/types.ts';
import { isChapteredFormat } from '../../shared/types.ts';
import { encodeAnchor, pagePercent, parseAnchor, overallPercent } from '../../shared/anchor.ts';
import {
  encodeMarkAnchor,
  isStaleMark,
  MAX_MARK_LENGTH,
  normalizeSelectionText,
  parseMarkAnchor,
} from '../../shared/mark-anchor.ts';
import { splitTextUnits, toUnitRange, unitIndexOfOffset, type TextUnit } from '../txt-units.ts';
import { fullToRender, layoutTxt, renderToFull } from '../txt-layout.ts';
import { applyMarks, collectFlowText, hasMeaningfulSelection, markIdOfElement, selectionOffsetInFlow } from '../marks.ts';
import type { WorkbenchApi } from '../api.ts';
import { fetchedIndexesOf } from '../api.ts';
import type { WorkbenchKey } from '../locales.ts';
import { renderMarkdown, sanitizeHtml } from '../markdown.ts';
import { rewriteChapterHtml } from '../chapter-html.ts';
import { BOOK_CSS_SCOPE, scopeBookCss } from '../book-css.ts';
import { restoreView, VIEWPORT_PADDING, type Pagination } from '../paginate.ts';
import { FlowReader } from './FlowReader.tsx';
import { PdfViewer } from './PdfViewer.tsx';

/**
 * 正文字体栈。
 *
 * 为什么字体要能被书内 CSS 覆盖或不覆盖两种状态都成立：
 * 用户选 `system`（默认）时书内 font-family 保留（尊重原书）；选了具体字体时
 * `scopeBookCss` 会丢弃书内 font-family（否则书内规则特异性更高，用户设置看起来"没反应"）。
 */
const FONT_STACKS = {
  system: undefined,
  serif: '"Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif',
  sans: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
} as const;

/** 组件依赖。 */
export interface ReaderViewProps {
  api: WorkbenchApi;
  t: (key: WorkbenchKey) => string;
  book: Book;
  settings: ReaderSettings;
  progress?: ReadingProgress;
  onSettingsChange(patch: Partial<ReaderSettings>): void;
  onBack(): void;
}

/** 首次分页前的占位（测量完成后被真实结果覆盖）。 */
const INITIAL_PAGINATION: Pagination = {
  columnWidth: 0,
  gap: 48,
  columnsPerView: 1,
  columnCount: 1,
  viewCount: 1,
};

/**
 * 是否是章节书（epub / mobi / web）。
 * 走共享谓词：网页书（web）与 epub/mobi 共用同一套「目录 + 按章加载」链路，
 * 原先这里与 Host 侧各自硬编码 `epub || mobi`，新增格式时极易漏改。
 */
function isChaptered(book: Book): boolean {
  return isChapteredFormat(book.format);
}

/**
 * 该单元是否为「纯标题页 / 分节页」（`EpubChapter.skip`，由 Host 在 manifest 里标出）。
 *
 * 这类章只有标题、没有正文，正文已被 Host 合并进**下一章**，因此：
 * 目录下拉不展示它、翻页与换章都要越过它。`index` 保持不变，所以旧进度锚点
 * （`chapter=N`）与划线锚点（`mark:ch=N`）不受影响 —— 本文件只在**导航**上跳过，
 * 从不重排索引。
 *
 * txt 的虚拟单元没有这个字段，恒为 false，行为与旧实现一致。
 */
function isSkippedChapter(chapter: EpubChapter | undefined): boolean {
  return chapter?.skip === true;
}

/**
 * 从 `from` 起沿 `direction`（+1 向后 / -1 向前）找第一个**非 skip** 的单元序，
 * `from` 自身也算在内。
 *
 * @param list - 全量单元清单（`unitList`：章节书 = 目录，索引空间必须保持原样）。
 * @param from - 起始序（可以越界，越界直接返回 undefined）。
 * @param direction - 搜索方向。
 * @returns 命中的单元序；越界或该方向上全是 skip 章时返回 undefined
 *   （调用方据此**保持原位**，绝不越界）。
 */
function findUnit(list: readonly EpubChapter[], from: number, direction: 1 | -1): number | undefined {
  for (let index = from; index >= 0 && index < list.length; index += direction) {
    if (!isSkippedChapter(list[index])) return index;
  }
  return undefined;
}

/** 阅读器。 */
export function ReaderView({
  api,
  t,
  book,
  settings,
  progress,
  onSettingsChange,
  onBack,
}: ReaderViewProps) {
  const chaptered = isChaptered(book);
  /**
   * 是否网页书（`book.source === 'web'`）。
   *
   * 逐章抓取标记、按需抓取的加载文案、加载失败重试**只对它生效**：
   * epub/mobi 的章节文件在导入时就全在本地，不存在「已下载 / 未下载」，
   * 给它们套这套 UI 只会凭空多出一排状态标记。
   */
  const isWeb = book.source === 'web';
  const [error, setError] = useState<string>();

  // ── 内容状态 ──
  const [toc, setToc] = useState<EpubChapter[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [chapterHtml, setChapterHtml] = useState<string>();
  const [textContent, setTextContent] = useState<string>();
  /**
   * 网页书：已抓章节的章序。
   *
   * **三态语义**（见 `fetchedIndexesOf` 的说明）：`undefined` = 未知（老 Host 产物没返回
   * `fetchedIndexes`，或状态查询失败），空 Set = 明确知道一章都没抓，非空 Set = 已抓集合。
   * 未知时整份标记不画 —— 不能退化成「全部未下载」，那会让用户以为书白抓了。
   * 非网页书恒为 undefined，下拉里不会多出任何字符。
   */
  const [fetchedIndexes, setFetchedIndexes] = useState<Set<number> | undefined>();
  /** 网页书「目录都没拉到时重跑载入流程」的计数器（其余重试走 goChapter）。 */
  const [reloadTick, setReloadTick] = useState(0);
  /** 打开时要恢复到的进度（章节书只在其锚点章节生效）。 */
  const initialAnchor = useRef(parseAnchor(progress?.anchor));

  /**
   * txt 的虚拟单元（其余格式恒为空数组）。
   *
   * 整本一次排版会把长书排成几百列（打开卡顿），这里切成若干单元，
   * 一次只渲染一个。短书只切出 1 个单元 → 行为与旧实现完全一致。
   */
  const txtUnits = useMemo<TextUnit[]>(
    () => (book.format === 'txt' && textContent !== undefined ? splitTextUnits(textContent) : []),
    [book.format, textContent],
  );
  /**
   * 导航单元清单：章节书 = 目录；txt = 虚拟单元。
   * 形状对齐 `EpubChapter`，这样换章按钮 / 章节选择器 / 进度百分比三处 UI 都能直接复用。
   */
  const unitList = useMemo<EpubChapter[]>(
    () => (chaptered ? toc : txtUnits.map((unit) => ({ index: unit.index, title: unit.title, href: '' }))),
    [chaptered, toc, txtUnits],
  );
  /** 单元总数（0 表示内容还没到）。 */
  const unitCount = unitList.length;
  /** 是否按「单元」导航（换章、单元选择器、全书百分比都看它）。 */
  const unitBased = chaptered || txtUnits.length > 1;
  /**
   * 目录下拉的**可选项**：剔除「纯标题页 / 分节页」（skip）。
   *
   * ⚠️ 只过滤渲染，`unitList` / `unitCount` 必须保持**全量**：
   * `goChapter` 的越界校验、`overallPercent` 的百分比分母都依赖原索引空间；
   * 一旦把过滤后的数组当成索引空间，进度百分比会偏大、锚点也会错位。
   */
  const selectableUnits = useMemo<EpubChapter[]>(
    () => unitList.filter((chapter) => !isSkippedChapter(chapter)),
    [unitList],
  );
  /**
   * 当前章在「可读章」里的可见序号（1 起）。
   *
   * 为什么不用 `chapterIndex + 1`：跳过 skip 章后内部索引会出现空洞
   * （1、2、4、5…），直接显示索引会让用户看到「章号跳号」，反而像丢了一章。
   * 显示层用可见序号，锚点仍用内部索引，两者互不影响。
   */
  const visibleChapterPosition = useMemo<number>(() => {
    const position = selectableUnits.findIndex((chapter) => chapter.index === chapterIndex);
    return position < 0 ? 1 : position + 1;
  }, [selectableUnits, chapterIndex]);
  /** 当前 txt 单元的全文偏移区间（划线换算用；章节书为 undefined）。 */
  const currentTxtUnit = chaptered ? undefined : txtUnits[chapterIndex];
  /**
   * 已下载章数（只数当前目录里已列出的章；状态未知时为 undefined）。
   * 与目录取交集而不是直接用 `fetchedIndexes.size`：Host 的已抓集合可能包含
   * 阅读器这份目录之外的新章（抓取过程中目录懒扩展），取交集才不会出现「已下载 10 / 共 8」。
   */
  const fetchedCount = useMemo<number | undefined>(() => {
    if (fetchedIndexes === undefined) return undefined;
    let count = 0;
    for (const chapter of unitList) if (fetchedIndexes.has(chapter.index)) count += 1;
    return count;
  }, [fetchedIndexes, unitList]);

  // ── 划线状态 ──
  /** 本书全部划线（挂载时拉一次；增删后本地同步）。 */
  const [marks, setMarks] = useState<Highlight[]>([]);
  /** 笔记抽屉开关。 */
  const [marksOpen, setMarksOpen] = useState(false);
  /** 选区浮动条位置（undefined = 不显示）。 */
  const [markPopup, setMarkPopup] = useState<{ x: number; y: number }>();
  /** 选区文本长度超限提示（一次性）。 */
  const [markNotice, setMarkNotice] = useState<string>();
  // ── 分页状态 ──
  const [pagination, setPagination] = useState<Pagination>(INITIAL_PAGINATION);
  const [view, setView] = useState(0);
  /** 待跳到「上一章最后一屏」（上翻跨章时置位，等分页结果到达再落位）。 */
  const [pendingEdge, setPendingEdge] = useState<'last' | undefined>();
  /** 已应用初始进度的章节（防止重排后反复跳回）。 */
  const restoredRef = useRef<string>();
  /**
   * 划线「定位」跨虚拟单元时的待办：先切到目标单元，等新单元分页结果到达再落位。
   * （txt 的锚点是全书偏移，可能落在别的单元里。）
   */
  const pendingMarkRef = useRef<{ unit: number; offset: number }>();

  /**
   * 翻页的**权威目标屏号**（同步更新，不是 React state）。
   *
   * 为什么必须有它：键盘连发 / 按住方向键时，每次 keydown 之间 React 未必已重渲染，
   * 若用闭包里的 `view` 做 `setView(view + 1)`，连续几次会算出同一个值 —— 只前进一屏
   * （表现为「按了没反应」或「跳得不准」）。这里在事件处理里**同步**推进目标值，
   * 保证一次按键恰好前进一屏；渲染后由 effect 与真实 `view` 对齐。
   */
  const targetViewRef = useRef(0);

  /** 跳屏的唯一入口：同步推进目标值 + 设置 state（两者永不脱节）。 */
  const jumpTo = useCallback((next: number): void => {
    targetViewRef.current = next;
    setView(next);
  }, []);

  /**
   * 连续翻页时关闭滑动动画。
   *
   * 单次翻页保留 .16s 滑动是有质感的；但快速连按/长按方向键时，
   * 每次按键都会从当前插值位置重启过渡，页面「追不上」按键，观感就是翻页不准。
   * 因此：两次翻页间隔小于过渡时长（200ms）时直接落位，间隔够久才动画。
   */
  const [instant, setInstant] = useState(false);
  const lastTurnAtRef = useRef(0);
  const instantTimer = useRef<number>();
  const TURN_INSTANT_WINDOW = 200;

  /** 标记一次翻页；判定是否属于「连打」并决定要不要跳过动画。 */
  const markTurn = useCallback((): void => {
    const now = performance.now();
    const rapid = now - lastTurnAtRef.current < TURN_INSTANT_WINDOW;
    lastTurnAtRef.current = now;
    if (instantTimer.current !== undefined) window.clearTimeout(instantTimer.current);
    if (rapid) {
      setInstant(true);
      // 连打停止后恢复动画
      instantTimer.current = window.setTimeout(() => setInstant(false), TURN_INSTANT_WINDOW + 40);
    } else {
      setInstant(false);
    }
  }, []);

  /** 强制下一次落位不做动画（换章、重排等场景）。 */
  const snapNext = useCallback((): void => {
    setInstant(true);
    if (instantTimer.current !== undefined) window.clearTimeout(instantTimer.current);
    instantTimer.current = window.setTimeout(() => setInstant(false), TURN_INSTANT_WINDOW + 40);
  }, []);

  useEffect(
    () => () => {
      if (instantTimer.current !== undefined) window.clearTimeout(instantTimer.current);
    },
    [],
  );

  useEffect(() => {
    targetViewRef.current = view;
  }, [view]);

  /**
   * 当前书 id 的最新镜像。
   *
   * 异步回来的抓取状态可能属于「上一本书」（用户快速换书时旧请求还没返回），
   * 落 state 前用它判定归属，避免把上一本的已抓集合画到新书上。
   */
  const currentBookRef = useRef(book.id);
  currentBookRef.current = book.id;

  /** 当前分页与章节信息的最新镜像（供事件处理里读取，避免闭包过期）。 */
  const navRef = useRef({ viewCount: 1, chapterIndex: 0, chapterCount: 0, units: [] as EpubChapter[] });
  navRef.current = { viewCount: pagination.viewCount, chapterIndex, chapterCount: unitCount, units: unitList };

  /**
   * 换章请求的**代际号**（M9）。
   *
   * 每次发起「取某章正文」都自增并记下自己的值，响应回来时与当前值比对：
   * 不一致说明期间又发起了新的请求（快速换章 / 网页书按需抓取 1~4 秒），本次结果必须**整体丢弃**。
   * 没有这道校验时，先发后到的旧章正文会覆盖新章 —— 正文是 A 章、章号与进度是 B 章。
   */
  const chapterRequestRef = useRef(0);

  /**
   * 视口/字号变化后页数可能变少，把越界的屏号收回末屏
   * （否则会停在空白屏上，工具条页码也会显示成 5/3 这种非法值）。
   */
  useEffect(() => {
    if (pagination.viewCount <= 0) return;
    const last = pagination.viewCount - 1;
    if (targetViewRef.current > last) jumpTo(last);
  }, [jumpTo, pagination.viewCount]);

  const onPagination = useCallback((next: Pagination): void => {
    setPagination((current) =>
      current.viewCount === next.viewCount &&
      current.columnCount === next.columnCount &&
      current.columnsPerView === next.columnsPerView &&
      current.columnWidth === next.columnWidth
        ? current
        : next,
    );
  }, []);

  // ── 网页书：逐章「已抓」状态 ──
  /**
   * 刷新「已抓章序」。
   *
   * 只在网页书调用（epub/mobi 没有这个概念）。查询失败静默保留上一次快照：
   * 状态标记只是辅助信息，不能因为它弹错误或打断阅读。
   * 章节加载成功后也要调它 —— Host 可能刚刚按需抓下了这一章，刷新后标记会从 ↓ 变 ✓。
   */
  const refreshFetchedIndexes = useCallback(async (): Promise<void> => {
    if (!isWeb) return;
    const bookId = book.id;
    try {
      const status = await api.webSourceStatus(bookId);
      const indexes = fetchedIndexesOf(status);
      if (indexes !== undefined && currentBookRef.current === bookId) setFetchedIndexes(indexes);
    } catch {
      /* 查询失败不打扰阅读：保持现有快照（未知仍是未知，已知仍是旧的已知） */
    }
  }, [api, book.id, isWeb]);

  /** 本地立刻把某章记为已抓：正文都已加载成功，这一条不必等 Host 校准。 */
  const markChapterFetched = useCallback((index: number): void => {
    setFetchedIndexes((current) => (current === undefined ? current : new Set(current).add(index)));
  }, []);

  // 换书 / 首次载入：先把状态清成「未知/空」（否则会短暂沿用上一本书的已抓集合），再查一次
  useEffect(() => {
    setFetchedIndexes(undefined);
    if (isWeb) void refreshFetchedIndexes();
  }, [isWeb, refreshFetchedIndexes]);

  // ── 载入内容 ──
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setChapterHtml(undefined);
    setTextContent(undefined);
    setPagination(INITIAL_PAGINATION);
    // 换书/首次载入：目标值也要一起归零，否则连按会从旧位置继续累加
    targetViewRef.current = 0;
    setView(0);

    if (chaptered) {
      const startChapter = initialAnchor.current?.chapter ?? 0;
      /** 本次取章的代际号（在 try 外声明：失败分支同样要判「是否已被更新的请求取代」）。 */
      let token: number | undefined;
      (async () => {
        try {
          const payload = await api.toc(book.id);
          if (cancelled) return;
          setToc(payload.chapters);
          const clamped = Math.min(Math.max(0, startChapter), Math.max(0, payload.chapters.length - 1));
          /*
           * 初始恢复纠偏：进度锚点可能落在「纯标题页 / 分节页」（skip）上 ——
           * 老进度就是这么存的，或者该章是这次才被 Host 折叠进下一章的。
           * 规则：先向后顺延到第一个非 skip 章；后面没有就往前退；再没有就留在原地
           * （全书只有 skip 页的极端数据只可能来自损坏的 manifest，不在这里抛错）。
           */
          const index = isSkippedChapter(payload.chapters[clamped])
            ? (findUnit(payload.chapters, clamped + 1, 1) ?? findUnit(payload.chapters, clamped - 1, -1) ?? clamped)
            : clamped;
          setChapterIndex(index);
          // 与 goChapter 共用代际号：目录刚出来、用户已经点走的情况下，本次响应必须作废
          token = chapterRequestRef.current += 1;
          const chapter = await api.chapter(book.id, index);
          if (cancelled || token !== chapterRequestRef.current) return;
          setChapterHtml(chapter.html);
          // 网页书：这一章既然读得到，它一定已在本地 —— 先本地标记（不等网络往返），
          // 再向 Host 校准整份已抓集合（按需抓取会顺带补上状态）
          if (isWeb) {
            markChapterFetched(index);
            void refreshFetchedIndexes();
          }
        } catch (cause) {
          // 失败分支同样判代际：已经作废的旧请求不该把「加载失败」盖到新章上
          if (cancelled) return;
          if (token !== undefined && token !== chapterRequestRef.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    } else {
      // 文本类：单元序先归零（txt 的单元数要等正文到了才知道，锚点单元随后再对）
      setChapterIndex(0);
      setToc([]);
      txtAnchorAppliedRef.current = false;
      (async () => {
        try {
          const payload = await api.content(book.id);
          if (cancelled) return;
          setTextContent(payload.content);
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [api, book.id, chaptered, isWeb, markChapterFetched, refreshFetchedIndexes, reloadTick]);

  /**
   * txt 的进度恢复第一步：单元切出来之后，把当前单元对到锚点所在的那个单元。
   * （章节书在载入 effect 里直接按 `anchor.chapter` 取章；txt 单元是本地切出来的，
   *   必须先有正文才知道有几个单元、锚点落在哪一个。）
   */
  const txtAnchorAppliedRef = useRef(false);
  useEffect(() => {
    if (chaptered || txtUnits.length === 0 || txtAnchorAppliedRef.current) return;
    txtAnchorAppliedRef.current = true;
    const anchor = initialAnchor.current;
    if (anchor === undefined) return;
    let unitIndex = anchor.chapter ?? 0;
    if (anchor.chapter === undefined && txtUnits.length > 1) {
      // 旧锚点（切虚拟单元之前存的）只有「全书百分比」：
      // 按比例折算成「单元序 + 单元内百分比」，否则会被当成第 0 单元的位置。
      const ratio = Math.min(1, Math.max(0, anchor.pct / 100));
      unitIndex = Math.min(txtUnits.length - 1, Math.floor(ratio * txtUnits.length));
      const unitPct = Math.max(0, Math.min(100, (ratio * txtUnits.length - unitIndex) * 100));
      // page 置 -1：旧 page 是「全书屏号」，在单元内已无意义，强制走百分比分支
      initialAnchor.current = { chapter: unitIndex, page: -1, pct: unitPct };
    }
    if (unitIndex > 0 && unitIndex < txtUnits.length) setChapterIndex(unitIndex);
  }, [chaptered, txtUnits]);

  /**
   * 书内样式表原文（epub）。
   *
   * 三态语义，调用方不得合并：
   * - `undefined`：还没取到（加载中，或根本不是章节书）；
   * - `''`：明确**没有**书内样式（mobi / 网页书 / 整包无 CSS）→ 走统一美化兜底；
   * - 非空：书内 CSS，经 `scopeBookCss` 作用域化后注入正文容器。
   */
  const [bookCssRaw, setBookCssRaw] = useState<string>();
  /** 书内样式**取失败**的原因（只有 reject 才是失败；空 CSS 不算）。 */
  const [bookCssError, setBookCssError] = useState<string>();

  /**
   * 取书内样式表（章节书才需要；Host 对 mobi/web 直接回空串，不会报错）。
   *
   * 失败纪律：**取不到就显式报错 + 降级到统一美化**，绝不当成「这本书没有样式」静默通过——
   * 用户会以为「美化开关坏了」，而真正的故障（路由未注册/文件缺失）被藏起来。
   */
  useEffect(() => {
    if (!chaptered) {
      setBookCssRaw(undefined);
      setBookCssError(undefined);
      return;
    }
    let cancelled = false;
    setBookCssRaw(undefined);
    setBookCssError(undefined);
    void api
      .bookStyles(book.id)
      .then((payload) => {
        if (cancelled) return;
        setBookCssRaw(payload.css);
        if (payload.warnings.length > 0) {
          // 非致命（个别表过大被跳过）：不打扰用户，但排查时必须能看到
          console.warn('[reading-workbench] 书内样式收集告警：', payload.warnings.join('；'));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setBookCssRaw('');
        setBookCssError(message);
        console.error('[reading-workbench] 书内样式加载失败，已降级为统一美化：', error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, book.id, chaptered]);

  /**
   * 作用域化后的书内 CSS（空串 = 不注入）。
   *
   * `unified` 模式直接返回空串：不注入 → 正文只剩 `dsh-reading-flow-book` 那套统一排版。
   * 解析放在 try 里：任何异常都必须变成可见的降级提示，而不是让 React 渲染期整块崩掉。
   */
  const bookCssText = useMemo(() => {
    if (!chaptered || bookCssRaw === undefined || bookCssRaw === '') return '';
    if ((settings.bookCss ?? 'book') === 'unified') return '';
    try {
      return scopeBookCss(bookCssRaw, {
        scope: BOOK_CSS_SCOPE,
        dropFontFamily: (settings.fontFamily ?? 'system') !== 'system',
      });
    } catch (error: unknown) {
      console.error('[reading-workbench] 书内样式作用域化失败，已降级为统一美化：', error);
      return '';
    }
  }, [bookCssRaw, chaptered, settings.bookCss, settings.fontFamily]);

  /** 正文字体族（undefined = 跟随 GUI 字体）。 */
  const fontFamily = FONT_STACKS[settings.fontFamily ?? 'system'];

  /** 已消毒的正文 HTML。 */
  const bodyHtml = useMemo(() => {
    if (chaptered) {
      if (chapterHtml === undefined) return undefined;
      const href = toc.find((chapter) => chapter.index === chapterIndex)?.href ?? '';
      return sanitizeHtml(rewriteChapterHtml(chapterHtml, { chapterHref: href, assetUrl: (path) => api.assetUrl(book.id, path) }));
    }
    if (textContent === undefined) return undefined;
    if (book.format === 'txt') return undefined; // TXT 走 layoutTxt 段落布局，不经 marked
    return renderMarkdown(textContent);
  }, [api, book.id, book.format, chapterHtml, chapterIndex, chaptered, textContent, toc]);

  /**
   * TXT 的段落布局（HTML + 「渲染文本 ↔ 原文偏移」双向映射）——只算**当前单元**。
   * 整本一次排版会把长书排成几百列（打开卡顿的根因），所以先切虚拟单元（见 txt-units.ts）。
   *
   * ⚠️ 变量名刻意叫 `txtLayout` 而不是 `plainText`：它的 `html` 是带 `<p>` 标签的富文本，
   * 且 DOM 里的文本已合并折行、剥掉段首缩进，**不再等于**原文。凡是拿它算偏移的地方
   * 都必须过 `fullToRender` / `renderToFull`。旧名 `plainText` 里装着 HTML，语义完全误导。
   * 依赖必须带 `settings.txtReflow`：切换「自动合并 / 保留原样」要立刻重排。
   */
  const txtLayout = useMemo(() => {
    if (book.format !== 'txt' || textContent === undefined) return undefined;
    const source = txtUnits.length > 0 ? (txtUnits[chapterIndex]?.text ?? textContent) : textContent;
    return layoutTxt(source, settings.txtReflow ?? 'auto');
  }, [book.format, chapterIndex, settings.txtReflow, textContent, txtUnits]);

  // ── 划线：拉取本书全部划线 ──
  useEffect(() => {
    let cancelled = false;
    setMarks([]);
    setMarksOpen(false);
    setMarkPopup(undefined);
    (async () => {
      try {
        const list = await api.listHighlights(book.id);
        if (!cancelled) setMarks(list);
      } catch {
        // 划线拉取失败不打扰阅读（笔记栏会显示为空）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, book.id]);

  // ── 划线：当前单元（章/虚拟单元/全书）内、可定位的划线（offset 一律是**渲染文本**偏移）──
  const currentUnitMarks = useMemo(() => {
    // txt 切了虚拟单元：锚点仍是**全书偏移**，这里换算成当前单元内偏移。
    // 锚点语义没变 → 旧划线（含未切分时代存的）无需迁移，依然定位准确。
    if (!chaptered && currentTxtUnit !== undefined) {
      const totalLength = textContent?.length ?? 0;
      const ranges: Array<{ id: string; offset: number; length: number }> = [];
      const layout = txtLayout;
      if (layout === undefined) return ranges;
      for (const mark of marks) {
        const anchor = parseMarkAnchor(mark.anchor);
        if (anchor === undefined) continue;
        // 过期判定用**原文**全书长度：锚点的 offset/length 都是原文偏移。
        if (isStaleMark(anchor, totalLength)) continue;
        const range = toUnitRange(currentTxtUnit, anchor.offset, anchor.length);
        if (range === undefined) continue;
        // 单元内原文区间 → DOM 的渲染区间（DOM 里既没有换行、也没有段首缩进）。
        // ⚠️ 长度必须「端点相减」换算：被删字符数不是定值，沿用 range.length 会让
        // 高亮多覆盖若干字符，且不会有任何报错（这是本轮最隐蔽的一处坑）。
        const offset = fullToRender(layout, range.offset);
        const length = fullToRender(layout, range.offset + range.length) - offset;
        if (length <= 0) continue;
        ranges.push({ id: mark.id, offset, length });
      }
      return ranges;
    }
    /**
     * 兜底分支（章节书 / 正文为空的 TXT）的过期判定长度。
     * ⚠️ 单位必须与锚点一致 —— 锚点是「纯文本字符偏移」，HTML 长度含标签、不是有效阈值：
     * - 正文为空的 TXT（没有单元）：没有可定位的划线，长度 0 让所有锚点都判过期；
     * - 章节书：章内纯文本长度此时拿不到（要等 DOM 渲染完），沿用 bodyHtml.length 作
     *   **宽松上界**（HTML 长度 ≥ 纯文本长度 → 更少判过期，宁可漏丢也不误丢有效划线）。
     * 旧代码用 (plainText ?? bodyHtml).length：plainText 改成 HTML 后这个长度会突然
     * 多出全部 `<p>` 标签，误判量随段落数增长 —— 必须按格式分开取值。
     */
    const unitTextLength = chaptered ? (bodyHtml ?? '').length : 0;
    return marks
      .map((mark) => ({ mark, anchor: parseMarkAnchor(mark.anchor) }))
      .filter((entry): entry is { mark: Highlight; anchor: NonNullable<ReturnType<typeof parseMarkAnchor>> } => {
        if (entry.anchor === undefined) return false;
        // 章节书只显示当前章的划线；文本类全部显示
        if (chaptered && entry.anchor.chapter !== chapterIndex) return false;
        // 内容改版后越界的划线静默跳过（笔记栏里仍可见）
        return !isStaleMark(entry.anchor, unitTextLength);
      })
      .map((entry) => ({ id: entry.mark.id, offset: entry.anchor.offset, length: entry.anchor.length }));
  }, [bodyHtml, chaptered, chapterIndex, currentTxtUnit, marks, textContent, txtLayout]);

  // ── 划线：正文渲染后恢复高亮（flowRef 与 unitKey 在下方定义，effect 里才取值）──
  const flowRefForMarks = useRef<HTMLDivElement | null>(null);

  /**
   * 按 DOM 找正文容器（ref 断裂时的最后兜底）。
   *
   * `.dsh-reading-flow` 在页面上是唯一的正文容器；ref 传不过来时这是可靠退路。
   * 单独抽成函数，供「划线创建」「恢复高亮」「笔记定位」共用同一套兜底逻辑。
   */
  const findFlowByDom = useCallback((): HTMLDivElement | null => {
    if (typeof document === 'undefined') return null;
    const element = document.querySelector('.dsh-reading-flow');
    return element === null ? null : (element as HTMLDivElement);
  }, []);

  /**
   * 取正文容器（划线偏移的坐标基准）。
   *
   * ⚠️ **为什么要兜底**（2026-10-20 用户反馈「划线操作后数据没保存」的根因）：
   * `flowRefForMarks` 靠「ReaderView 建 ref → 传给 FlowReader → FlowReader 绑给 DOM」
   * 这条链传递。只要链上任何一环在条件渲染/重挂载时断掉，`current` 就是 `null`，
   * 而 `createMark` 原来直接 `if (root === null) return` —— **静默失败**，
   * 用户看到的就是「点了划线没反应、没报错、数据也没保存」。
   *
   * 兜底策略（从选区节点向上找）比「按 class 全局查询」更精确：
   * 页面上可能同时存在多个正文容器（双页 / 预览），向上找保证拿到**选区所在的那一个**。
   *
   * @param selection - 当前选区（可为空）
   * @returns 正文容器；真的找不到时返回 null
   */
  const resolveFlowRoot = useCallback((selection: Selection | null): HTMLDivElement | null => {
    const fromRef = flowRefForMarks.current;
    if (fromRef !== null) return fromRef;
    const anchor = selection?.anchorNode;
    if (anchor === null || anchor === undefined) return findFlowByDom();
    const element = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    const flow = element?.closest('.dsh-reading-flow');
    // 不用 `instanceof HTMLDivElement`：非浏览器环境（jsdom 单测 / SSR）里该构造器可能不存在，
    // 会让这条兜底路径自己抛错。closest 能命中就说明是元素，直接断言即可。
    if (flow === null || flow === undefined) return findFlowByDom();
    return flow as HTMLDivElement;
  }, [findFlowByDom]);

  // ── 划线：选区浮动条（mouseup 后有有效选区时出现）──
  const onReaderMouseUp = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      const selection = window.getSelection();
      if (!hasMeaningfulSelection(selection)) {
        setMarkPopup(undefined);
        return;
      }
      if (selection === null) return;
      const text = selection.toString();
      if (text.trim().length > MAX_MARK_LENGTH) {
        setMarkNotice(t('mark.tooLong'));
        setMarkPopup(undefined);
        return;
      }
      setMarkNotice(undefined);
      const rect = event.currentTarget.getBoundingClientRect();
      // 浮动条贴在选区终点上方（坐标限制在视口内）
      const range = selection.getRangeAt(0);
      const box = range.getBoundingClientRect();
      const x = Math.min(Math.max(box.left - rect.left, 8), Math.max(8, rect.width - 120));
      const y = Math.max(box.top - rect.top - 44, 4);
      setMarkPopup({ x, y });
    },
    [t],
  );

  /** 确认划线：算偏移 → 入库 → 本地追加 → 清选区。 */
  const createMark = useCallback(async (): Promise<void> => {
    const selection = window.getSelection();
    setMarkPopup(undefined);
    /*
     * 下面每一处失败都必须**说出来**。
     *
     * 历史教训（2026-10-20 用户反馈「划线操作后数据没保存」）：这里原来全是裸 `return`，
     * 根因有两层 —— 浮动按钮没在 mousedown 上 preventDefault（浏览器先清空选区），
     * 以及 `flowRefForMarks.current` 可能为 null（见 resolveFlowRoot 的说明）。
     * 两者都会走到静默 return，用户看到「点了没反应」，没有任何提示，也没法自查。
     * 「静默失败」比失败本身更难查，所以每一条失败路径都要有可见提示。
     */
    const root = resolveFlowRoot(selection);
    if (root === null) {
      setMarkNotice(t('mark.failed.notReady'));
      return;
    }
    if (!hasMeaningfulSelection(selection)) {
      setMarkNotice(t('mark.failed.selectionLost'));
      return;
    }
    if (selection === null) return;
    const hit = selectionOffsetInFlow(root, selection);
    if (hit === undefined) {
      setMarkNotice(t('mark.failed.outOfFlow'));
      return;
    }
    const text = normalizeSelectionText(selection.toString());
    if (text === '') {
      setMarkNotice(t('mark.failed.empty'));
      return;
    }
    /**
     * ⚠️ 方向：渲染 → 原文。
     * `selectionOffsetInFlow` 给的是 **DOM（渲染文本）**偏移，因为 flow 里装的是 layoutTxt
     * 的产物；锚点必须记 **原文**偏移，所以先过 `renderToFull` 换回单元内原文偏移。
     * 长度同样用端点相减 —— 渲染区间两端之间在原文里还夹着被删掉的换行/段首缩进，
     * 直接沿用 hit.length 存库，划线会整体偏短（而且不会有任何报错）。
     */
    const layout = txtLayout;
    const unitOffset = layout === undefined ? hit.offset : renderToFull(layout, hit.offset);
    const unitLength = layout === undefined ? hit.length : renderToFull(layout, hit.offset + hit.length) - unitOffset;
    // 锚点统一记「全书偏移」：txt 的单元内偏移在这里加回单元起点。
    // （DOM 上仍是渲染偏移，见下面的 applyMarks。）
    const fullOffset = currentTxtUnit === undefined ? unitOffset : currentTxtUnit.start + unitOffset;
    const anchor = encodeMarkAnchor({
      chapter: chaptered ? chapterIndex : undefined,
      offset: fullOffset,
      length: unitLength,
    });
    try {
      const created = await api.createHighlight({ bookId: book.id, text, anchor });
      setMarks((current) => [...current, created]);
      // 立即高亮本条（不等重渲染链路）：DOM 上要用**渲染**偏移，故把原文区间再换回去。
      // 这一处与上面方向相反，两处必须成对存在 —— 少一处就是「存的偏移和用的偏移不同源」。
      const renderOffset = layout === undefined ? unitOffset : fullToRender(layout, unitOffset);
      const renderLength =
        layout === undefined ? unitLength : fullToRender(layout, unitOffset + unitLength) - renderOffset;
      applyMarks(root, [{ id: created.id, offset: renderOffset, length: renderLength }]);
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, book.id, chaptered, chapterIndex, currentTxtUnit, resolveFlowRoot, txtLayout]);

  /** 删除划线。 */
  const removeMark = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.deleteHighlight(id);
        setMarks((current) => current.filter((mark) => mark.id !== id));
        const root = flowRefForMarks.current;
        if (root !== null) applyMarks(root, currentUnitMarks.filter((mark) => mark.id !== id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, currentUnitMarks],
  );

  /** 更新划线笔记。 */
  const updateMarkNote = useCallback(
    (id: string, note: string): void => {
      setMarks((current) => current.map((mark) => (mark.id === id ? { ...mark, note } : mark)));
      void api.updateHighlightNote(id, note).catch(() => {
        /* 笔记保存失败不打扰阅读（本地已更新，下次打开回落） */
      });
    },
    [api],
  );

  // ── 恢复进度：分页结果首次可用时应用一次 ──
  const unitKey = unitBased ? `unit:${chapterIndex}` : 'book';
  useEffect(() => {
    if (pagination.viewCount <= 1 && pagination.columnCount <= 1) return;
    if (restoredRef.current === unitKey) return;
    restoredRef.current = unitKey;

    // 划线「定位」跨单元时留下的目标：切过来后直接落到对应屏
    const pendingMark = pendingMarkRef.current;
    if (pendingMark !== undefined && pendingMark.unit === chapterIndex) {
      pendingMarkRef.current = undefined;
      const unitStart = currentTxtUnit?.start ?? 0;
      const unitLength = currentTxtUnit === undefined ? 0 : currentTxtUnit.end - currentTxtUnit.start;
      const ratio = unitLength > 0 ? Math.max(0, Math.min(1, (pendingMark.offset - unitStart) / unitLength)) : 0;
      jumpTo(Math.min(pagination.viewCount - 1, Math.round(ratio * (pagination.viewCount - 1))));
      return;
    }

    const anchor = initialAnchor.current;
    const sameUnit = !unitBased || anchor?.chapter === chapterIndex;
    if (anchor !== undefined && sameUnit && (anchor.page > 0 || anchor.pct > 0)) {
      jumpTo(restoreView(anchor.page, anchor.pct, pagination.viewCount));
      return;
    }
    if (pendingEdge === 'last') {
      setPendingEdge(undefined);
      jumpTo(pagination.viewCount - 1);
      return;
    }
    jumpTo(0);
  }, [chapterIndex, currentTxtUnit, jumpTo, pendingEdge, pagination.columnCount, pagination.viewCount, unitBased, unitKey]);

  // ── 保存进度（防抖；页/章变化时写入）──
  const lastSaved = useRef<string>('');
  useEffect(() => {
    if (pagination.viewCount <= 0) return;
    const unitPercent = pagePercent(view, pagination.viewCount);
    const anchor = encodeAnchor(
      unitBased ? { chapter: chapterIndex, page: view, pct: unitPercent } : { page: view, pct: unitPercent },
    );
    const percent = unitBased
      ? overallPercent({ chapter: chapterIndex, page: view, pct: unitPercent }, Math.max(1, unitCount))
      : unitPercent;
    const key = `${anchor}|${percent.toFixed(1)}`;
    if (lastSaved.current === key) return;
    lastSaved.current = key;
    const timer = window.setTimeout(() => {
      void api.saveProgress({ bookId: book.id, anchor, percent }).catch(() => {
        /* 进度保存失败不打扰阅读 */
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [api, book.id, chapterIndex, pagination.viewCount, unitBased, unitCount, view]);

  // ── 翻页 / 翻章 ──
  const goChapter = useCallback(
    (index: number, edge?: 'last'): void => {
      if (index < 0 || index >= unitCount) return;
      /*
       * 落点纠偏：目标若是「纯标题页 / 分节页」（skip），按翻页方向越到最近的非 skip 章。
       * - `edge === 'last'` 表示从后往前翻（prevPage），应落到目标**之前**的正文；
       * - 其余调用（目录选择、章内链接、下一页、初始恢复）一律向后找。
       * 该方向已无正文时**保持原位**：既不越界，也不把只有标题的一页当正文展示。
       */
      const landing = isSkippedChapter(unitList[index])
        ? findUnit(unitList, index + (edge === 'last' ? -1 : 1), edge === 'last' ? -1 : 1)
        : index;
      if (landing === undefined) return;
      // 换章前先清掉上一次的错误：否则重试成功的章节上还挂着「加载失败」（同一章序重试也走这里）
      setError(undefined);
      setPendingEdge(edge);
      setChapterIndex(landing);
      // 换章：重新取正文（同一 effect 链路由 unitKey 重置恢复逻辑）
      setChapterHtml(undefined);
      /*
       * M8：分页边界必须跟正文一起复位。
       * 上一章有几屏、当前屏号是多少，在换章这一刻全部失去意义；不复位的话，
       * 加载期按「下一页」会用**上一章的屏数**判边界 —— 上一章只有 1 屏时
       * `target(1) >= viewCount(1)` 被误判成「本章末屏」，于是直接再换一章，中间整章被跳过。
       * 复位后 `pagination` / `navRef.viewCount` 立刻回到「1 屏」，键盘、点击热区、工具条
       * 都不会再拿到上一章的边界（新分页由 FlowReader 排版完成后经 onPagination 上报）。
       */
      setPagination(INITIAL_PAGINATION);
      restoredRef.current = undefined;
      // 新章未排版前先把目标归零：期间若连按键盘，从新章第 0 屏起算而不是旧位置累加；
      // 若带了 edge='last'，恢复 effect 会在分页结果到达后把它改到末屏。
      targetViewRef.current = 0;
      setView(0);
      // 换章是内容整体替换，横滑动画只会让人觉得「翻错页」，直接落位
      snapNext();
      // txt 的单元正文是从 textContent 本地切出来的，不需要再取；章节书才按章拉 HTML。
      if (!chaptered) return;
      // M9：代际号。旧请求（快速换章 / 网页书按需抓取 1~4 秒）后到时 token 已变，结果整体丢弃
      const token = (chapterRequestRef.current += 1);
      void (async () => {
        try {
          const chapter = await api.chapter(book.id, landing);
          if (token !== chapterRequestRef.current) return;
          setChapterHtml(chapter.html);
          // 网页书：这一章（可能刚被 Host 按需抓下来）读到即已下载，本地先标、再向 Host 校准
          if (isWeb) {
            markChapterFetched(landing);
            void refreshFetchedIndexes();
          }
        } catch (cause) {
          // 作废请求的失败同样不算数：它会把「加载失败」盖到已经换过去的新章上
          if (token !== chapterRequestRef.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [api, book.id, chaptered, isWeb, markChapterFetched, refreshFetchedIndexes, snapNext, unitCount, unitList],
  );

  /**
   * 重新加载当前章节（网页书加载失败后的「重试」）。
   *
   * 复用换章链路：`goChapter` 会先清空正文再重新拉取，同一章序也能触发。
   * 目录都没拉到时 `goChapter` 会被 `unitCount` 挡住（压根没有章序可选），
   * 此时退回「重跑载入 effect」——那是唯一能重新拉目录的入口。
   */
  const retryLoad = useCallback((): void => {
    setError(undefined);
    if (unitCount > 0) {
      goChapter(chapterIndex);
      return;
    }
    setReloadTick((tick) => tick + 1);
  }, [chapterIndex, goChapter, unitCount]);

  /** 笔记栏「定位」：跳到该划线所在屏（txt 跨虚拟单元时先切单元，落位交回恢复 effect）。 */
  const jumpToMark = useCallback(
    (mark: Highlight): void => {
      const anchor = parseMarkAnchor(mark.anchor);
      if (anchor === undefined) return;
      const unitStart = currentTxtUnit?.start ?? 0;
      if (currentTxtUnit !== undefined) {
        const targetUnit = unitIndexOfOffset(txtUnits, anchor.offset);
        if (targetUnit !== chapterIndex) {
          pendingMarkRef.current = { unit: targetUnit, offset: anchor.offset };
          setMarksOpen(false);
          goChapter(targetUnit);
          return;
        }
      }
      const root = flowRefForMarks.current;
      if (root !== null) {
        // 用「当前位置占当前单元文本的比例」换算目标屏，重排后依然大致准确。
        // ⚠️ 量纲必须一致：flow.text 是 **DOM 渲染文本**（TXT 已删掉换行与段首缩进），
        // 而 unitOffset 是 **原文**偏移 —— 拿原文偏移当分子会让落位整体偏后，
        // 且删得越多偏得越多（老 txt 折行多，偏得最明显）。TXT 先过 fullToRender。
        const flow = collectFlowText(root);
        const unitOffset = Math.max(0, anchor.offset - unitStart);
        const layout = txtLayout;
        const renderOffset = layout === undefined ? unitOffset : fullToRender(layout, unitOffset);
        const ratio = flow.text.length > 0 ? renderOffset / flow.text.length : 0;
        const target = Math.min(pagination.viewCount - 1, Math.round(ratio * (pagination.viewCount - 1)));
        jumpTo(target);
        setMarksOpen(false);
        window.setTimeout(() => {
          const node = root.querySelector(`[data-dsh-mark-id="${mark.id}"]`);
          node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 240);
      }
    },
    [chapterIndex, currentTxtUnit, goChapter, jumpTo, pagination.viewCount, txtLayout, txtUnits],
  );

  /**
   * 下一页。目标值同步推进，保证连按 / 长按每按一次前进一屏；
   * 到章末再翻则进入下一章（由 goChapter 重置目标）。
   */
  const nextPage = useCallback((): void => {
    /*
     * M8 的第一道防线：章节书正文还没到（换章 / 首次载入中）时**直接丢弃**这次翻页。
     * 此刻 `navRef.viewCount` 属于上一章（或已被 goChapter 复位成 1），任何一次「下一页」
     * 都可能被误判成「本章末屏 → 换下一章」：上一章只有 1 屏时，中间那章会被整章跳过。
     * 丢弃是正确行为 —— 正文到达后 FlowReader 重排，用户再按一次就落在新章。
     */
    if (chaptered && chapterHtml === undefined) return;
    const { viewCount, chapterIndex: currentChapter, units } = navRef.current;
    const target = targetViewRef.current + 1;
    markTurn();
    if (target < viewCount) {
      jumpTo(target);
      return;
    }
    if (unitBased) {
      // 向后找第一个非 skip 章：跳过的章（纯标题页）不占一次翻页
      const next = findUnit(units, currentChapter + 1, 1);
      if (next !== undefined) {
        goChapter(next);
        return;
      }
    }
    // 已是全书末屏：把目标钉回末屏，避免越界后「再按没反应」
    targetViewRef.current = Math.max(0, viewCount - 1);
  }, [chapterHtml, chaptered, goChapter, jumpTo, markTurn, unitBased]);

  /** 上一页（同样同步推进目标值）。 */
  const prevPage = useCallback((): void => {
    // 与 nextPage 对称：正文未到时的翻页一律丢弃（否则会从旧边界再往前跨一章）
    if (chaptered && chapterHtml === undefined) return;
    const { chapterIndex: currentChapter, units } = navRef.current;
    const target = targetViewRef.current - 1;
    markTurn();
    if (target >= 0) {
      jumpTo(target);
      return;
    }
    if (unitBased) {
      // 向前找第一个非 skip 章；edge='last' 让恢复 effect 把它落到末屏
      const prev = findUnit(units, currentChapter - 1, -1);
      if (prev !== undefined) {
        goChapter(prev, 'last');
        return;
      }
    }
    targetViewRef.current = 0;
  }, [chapterHtml, chaptered, goChapter, jumpTo, markTurn, unitBased]);

  // ── 滚轮翻页 ──
  // 用 ref 转一手，handler 恒等：否则每次翻页重渲染都会让 FlowReader
  // 卸载并重挂 wheel 监听，累加器被清零，滚轮手感变得断断续续。
  const wheelPageRef = useRef<(direction: 1 | -1) => void>(() => {});
  wheelPageRef.current = (direction: 1 | -1): void => {
    if (direction === 1) nextPage();
    else prevPage();
  };
  const onWheelPage = useCallback((direction: 1 | -1): void => {
    wheelPageRef.current(direction);
  }, []);

  // ── 键盘 ──
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          nextPage();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          prevPage();
          break;
        case 'Home':
          jumpTo(0);
          break;
        case 'End':
          jumpTo(pagination.viewCount - 1);
          break;
        case 'Escape':
          onBack();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpTo, nextPage, onBack, pagination.viewCount, prevPage]);

  // ── 点击翻页（左右热区；有选区或点在链接上时不翻）──
  const onReaderClick = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    // 划线上的点击：定位到笔记栏对应条目
    const markId = markIdOfElement(target);
    if (markId !== undefined) {
      const mark = marks.find((entry) => entry.id === markId);
      if (mark !== undefined) {
        setMarksOpen(true);
        return;
      }
    }
    // 章节内链接：切到对应章节
    const anchor = target.closest('a[data-dsh-chapter-link]');
    if (anchor !== null) {
      event.preventDefault();
      const href = anchor.getAttribute('data-dsh-chapter-link');
      const index = toc.findIndex((chapter) => chapter.href === href);
      if (index >= 0) goChapter(index);
      return;
    }
    // 外链交给浏览器（已在重写阶段加了 target=_blank）
    if (target.closest('a') !== null) return;
    // 有文字选区时不翻页（用户正在选字）
    const selection = window.getSelection();
    if (selection !== null && selection.toString().trim() !== '') return;

    // 比值要按**正文内容盒**算，不能按含左右内边距的视口算，
    // 否则热区会整体偏左（视口有 VIEWPORT_PADDING 的内边距）。
    const rect = event.currentTarget.getBoundingClientRect();
    const contentWidth = Math.max(1, rect.width - VIEWPORT_PADDING * 2);
    const ratio = (event.clientX - rect.left - VIEWPORT_PADDING) / contentWidth;
    if (pagination.columnsPerView === 2) {
      // 双页：左右各占一半，符合「点左边回看、点右边继续」的直觉
      if (ratio < 0.5) prevPage();
      else nextPage();
      return;
    }
    if (ratio < 0.3) prevPage();
    else if (ratio > 0.7) nextPage();
  };

  /** 当前百分比（工具条展示）。 */
  const currentPercent = unitBased
    ? overallPercent(
        { chapter: chapterIndex, page: view, pct: pagePercent(view, pagination.viewCount) },
        Math.max(1, unitCount),
      )
    : pagePercent(view, pagination.viewCount);

  /**
   * 工具条「上一章 / 下一章」按钮是否还有可去的正文（跳过 skip 章之后判定）。
   * 与 nextPage/prevPage 用同一个 `findUnit`：只影响按钮的 disabled 观感，
   * 点下去的真实行为始终由 nextPage/prevPage 决定，两处不会各说各话。
   */
  const prevUnitIndex = useMemo(
    () => (unitBased ? findUnit(unitList, chapterIndex - 1, -1) : undefined),
    [chapterIndex, unitBased, unitList],
  );
  const nextUnitIndex = useMemo(
    () => (unitBased ? findUnit(unitList, chapterIndex + 1, 1) : undefined),
    [chapterIndex, unitBased, unitList],
  );

  const loading = chaptered ? chapterHtml === undefined : textContent === undefined;
  /**
   * 加载中的提示文案。
   *
   * 只有**明确知道当前章还没抓到本地**时才说「正在抓取本章」—— 此刻 Host 正在按需抓取
   * （1~4 秒，见 http.ts 的 /content 分支），把等待原因讲出来才不显得是卡死。
   * 状态未知时（老 Host 产物 / 状态查询失败）退回通用「加载中…」：
   * 宁可不解释，也不猜 —— 猜错比不说更误导。
   */
  const loadingText =
    isWeb && fetchedIndexes !== undefined && !fetchedIndexes.has(chapterIndex)
      ? t('reader.fetchingChapter')
      : t('reader.loading');
  // TXT 走段落布局（每段一个 <p>）；其余格式用已消毒的 bodyHtml。
  // 章节书恒有 bodyHtml；txt 的 txtLayout 只在正文到达后存在，兜底成空串（此时还在 loading）。
  const html = chaptered ? (bodyHtml ?? '') : (txtLayout?.html ?? bodyHtml ?? '');

  // ── 划线：正文渲染后恢复高亮（依赖真实 DOM，放渲染期计算之后）──
  useEffect(() => {
    // ref 可能是 null（见 findFlowByDom 的说明）；不兜底的话划线「存上了却不显示」，
    // 用户会以为根本没保存成功 —— 与本次 bug 的观感完全一样，必须有兜底。
    const root = flowRefForMarks.current ?? findFlowByDom();
    if (root === null || currentUnitMarks.length === 0) return;
    applyMarks(root, currentUnitMarks);
  }, [currentUnitMarks, findFlowByDom, html]);

  return (
    <section className="dsh-reading-reader" aria-label={book.title}>
      {/* 书内样式：作用域化后注入（选择器全部挂在 .dsh-reading-flow 下，不污染 GUI），
          随阅读器卸载由 React 一并移除。用 <style> 而不是 styles.insert：
          它是随书变化的动态内容，生命周期应当与这本书的阅读会话一致。 */}
      {bookCssText !== '' && <style data-dsh-book-css={book.id} dangerouslySetInnerHTML={{ __html: bookCssText }} />}
      <header className="dsh-reading-toolbar">
        <button type="button" className="dsh-reading-iconbtn" title={t('reader.back')} onClick={onBack}>
          ‹ {t('reader.back')}
        </button>
        <div className="dsh-reading-toolbar-title">
          <span className="dsh-reading-toolbar-book" title={book.title}>
            {book.title}
          </span>
          {unitBased && selectableUnits.length > 1 && (
            <>
              <select
                className="dsh-reading-chapterselect"
                value={chapterIndex}
                aria-label={t('reader.chapter')}
                onChange={(event) => goChapter(Number(event.target.value))}
              >
                {/* 只列可读的章：`skip` 是「纯标题页 / 分节页」，内容已并入下一章，
                    单独列出来会让用户点进去只看到一屏标题（正是本次要修的症状）。
                    `unitList` 本身仍是全量，索引空间不变。 */}
                {selectableUnits.map((chapter, position) => {
                  /**
                   * 逐章抓取状态：只对网页书且状态已知时才有值。
                   * `undefined` = 未知（老 Host 产物 / 状态查询失败）→ 不画任何标记；
                   * `true` = 已下载（✓）；`false` = 未下载（↓，点开会自动抓取）。
                   */
                  const fetched =
                    isWeb && fetchedIndexes !== undefined ? fetchedIndexes.has(chapter.index) : undefined;
                  return (
                    <option
                      key={chapter.index}
                      value={chapter.index}
                      data-fetched={fetched === undefined ? undefined : fetched ? 'true' : 'false'}
                    >
                      {fetched === true ? '✓ ' : fetched === false ? '↓ ' : ''}
                      {position + 1}. {chapter.title}
                    </option>
                  );
                })}
              </select>
              {/* 状态补语 + 图例：drop-down 里的 ✓/↓ 需要一处解释，否则用户看不懂符号 */}
              {isWeb && (
                <span
                  className="dsh-reading-chapterstatus"
                  title={
                    fetchedIndexes === undefined
                      ? t('reader.chapterStatus.unknown')
                      : `${t('reader.chapterStatus')
                          .replace('{fetched}', String(fetchedCount ?? 0))
                          .replace('{total}', String(unitCount))} · ${t('reader.chapterLegend')}`
                  }
                >
                  {fetchedIndexes === undefined
                    ? t('reader.chapterStatus.unknown')
                    : `✓ ${fetchedCount ?? 0}/${unitCount}`}
                </span>
              )}
            </>
          )}
        </div>
        <div className="dsh-reading-toolbar-actions">
          <button
            type="button"
            className={marks.length > 0 ? 'dsh-reading-iconbtn dsh-reading-marksbtn-active' : 'dsh-reading-iconbtn'}
            title={t('mark.drawer')}
            onClick={() => setMarksOpen((open) => !open)}
          >
            {t('mark.button')} {marks.length > 0 ? marks.length : ''}
          </button>
          {/* TXT 换行重排开关：只对 txt 渲染。
              别的格式各有一套结构化排版（md 走 marked、epub/mobi 是章节 HTML），
              给它们显示一个无效控件只会让工具条变挤。 */}
          {book.format === 'txt' && (
            <div className="dsh-reading-segmented" role="group" aria-label={t('reader.txtReflow')}>
              {(['auto', 'preserve'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={
                    (settings.txtReflow ?? 'auto') === value ? 'dsh-reading-seg dsh-reading-seg-active' : 'dsh-reading-seg'
                  }
                  onClick={() => onSettingsChange({ txtReflow: value })}
                >
                  {t(`reader.txtReflow.${value}` as WorkbenchKey)}
                </button>
              ))}
            </div>
          )}
          {/* 正文样式来源：只有章节书（epub/mobi/web）有「书内 CSS」这个概念，
              别的格式没有第二个选项，给它们显示等于多一个无效控件。 */}
          {chaptered && (
            <select
              className="dsh-reading-toolbar-select"
              title={t('reader.bookCss')}
              aria-label={t('reader.bookCss')}
              value={settings.bookCss ?? 'book'}
              onChange={(event) => onSettingsChange({ bookCss: event.target.value === 'unified' ? 'unified' : 'book' })}
            >
              <option value="book">{t('reader.bookCss.book')}</option>
              <option value="unified">{t('reader.bookCss.unified')}</option>
            </select>
          )}
          {/* 字体对全部文本格式生效（txt/md 同样受益），不限章节书。 */}
          <select
            className="dsh-reading-toolbar-select"
            title={t('reader.fontFamily')}
            aria-label={t('reader.fontFamily')}
            value={settings.fontFamily ?? 'system'}
            onChange={(event) => {
              const value = event.target.value;
              onSettingsChange({ fontFamily: value === 'serif' || value === 'sans' ? value : 'system' });
            }}
          >
            <option value="system">{t('reader.fontFamily.system')}</option>
            <option value="serif">{t('reader.fontFamily.serif')}</option>
            <option value="sans">{t('reader.fontFamily.sans')}</option>
          </select>
          <div className="dsh-reading-segmented" role="group" aria-label={t('reader.layout')}>
            {([['auto', 'auto'], [1, 'one'], [2, 'two']] as const).map(([value, label]) => (
              <button
                key={String(value)}
                type="button"
                className={settings.columns === value ? 'dsh-reading-seg dsh-reading-seg-active' : 'dsh-reading-seg'}
                onClick={() => onSettingsChange({ columns: value })}
              >
                {t(`reader.layout.${label}` as WorkbenchKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="dsh-reading-iconbtn"
            title={t('reader.fontSmaller')}
            onClick={() => onSettingsChange({ fontSize: Math.max(13, settings.fontSize - 1) })}
          >
            A－
          </button>
          <button
            type="button"
            className="dsh-reading-iconbtn"
            title={t('reader.fontLarger')}
            onClick={() => onSettingsChange({ fontSize: Math.min(28, settings.fontSize + 1) })}
          >
            A＋
          </button>
        </div>
      </header>

      {/* 顶部错误条：网页书加载失败时由正文区的「错误原文 + 重试」块承担，
          这里让位避免重复；其余格式（含 epub/mobi）与旧行为一致，照旧显示在这里 */}
      {error !== undefined && !(isWeb && loading) && <p className="dsh-reading-error">{t('error.load')}: {error}</p>}
      {/* 书内样式取失败：显式告诉用户「现在看到的是统一美化」，而不是静默降级。
          刻意不阻断阅读 —— 正文本身是好的，只是排版退回通用样式。 */}
      {bookCssError !== undefined && (
        <p className="dsh-reading-hint dsh-reading-hint-warn">
          {t('reader.bookCss.failed')}：{bookCssError}
        </p>
      )}
      {markNotice !== undefined && <p className="dsh-reading-error dsh-reading-floating">{markNotice}</p>}

      {book.format === 'pdf' ? (
        <PdfViewer
          fileUrl={api.fileUrl(book.id)}
          columns={settings.columns}
          initialPage={initialAnchor.current?.page ?? 0}
          // PDF 划线：锚点复用 mark 格式，`ch` 装页序号（0 起）、`off` 装页内字符偏移。
          marks={marks}
          onCreateMark={(pageIndex, offset, length, text) => {
            void (async () => {
              try {
                const anchor = encodeMarkAnchor({ chapter: pageIndex, offset, length });
                const created = await api.createHighlight({ bookId: book.id, text, anchor });
                setMarks((current) => [...current, created]);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            })();
          }}
          onProgress={(page, pageCount) => {
            const pct = pagePercent(page, pageCount);
            void api
              .saveProgress({
                bookId: book.id,
                anchor: encodeAnchor({ page, pct }),
                percent: pct,
              })
              .catch(() => {
                /* 忽略 */
              });
          }}
        />
      ) : loading && error !== undefined && isWeb ? (
        /* 网页书加载失败：绝不再原地空转「加载中…」（用户实测的痛点：点第 2 章报错后一直转），
           改为显式报错 + 重试按钮；Host 的 502 中文说明**原样显示**，不吞掉、不改写。
           ⚠️ 刻意只对 isWeb 生效：epub/mobi 全在本地、不存在「抓取失败」，
              它们保持旧的「顶部错误条 + 加载占位」，行为一个字符都不变。 */
        <div className="dsh-reading-loadfail">
          <p className="dsh-reading-error">
            {t('error.load')}: {error}
          </p>
          <p className="dsh-reading-hint">{t('reader.fetchFailed.hint')}</p>
          <button type="button" className="dsh-reading-secondary" onClick={retryLoad}>
            {t('reader.retry')}
          </button>
        </div>
      ) : loading ? (
        <p className="dsh-reading-hint dsh-reading-center">{loadingText}</p>
      ) : (
        <>
          <FlowReader
            html={html}
            plain={book.format === 'txt'}
            book={chaptered}
            fontSize={settings.fontSize}
            lineHeight={settings.lineHeight}
            fontFamily={fontFamily}
            columns={settings.columns}
            view={view}
            instant={instant}
            flowRef={flowRefForMarks}
            onPagination={onPagination}
            onReaderClick={onReaderClick}
            onReaderMouseUp={onReaderMouseUp}
            onWheelPage={onWheelPage}
            // 书内样式到达/失效都会改变排版宽度：把它的长度并入 contentKey，强制重测
            contentKey={`${book.id}:${unitKey}:${bookCssText.length}`}
          />
          {markPopup !== undefined && (
            <div
              className="dsh-reading-markpopup"
              style={{ left: `${markPopup.x}px`, top: `${markPopup.y}px` }}
            >
              <button
                type="button"
                className="dsh-reading-markpopup-btn"
                /*
                 * ⚠️ 必须在 mousedown 上 preventDefault，否则**划线永远存不上**：
                 * 浏览器在按钮 mousedown 时就会清空 selection，等到 click 触发，
                 * `window.getSelection()` 已经是空的 → createMark 第一处判定静默 return。
                 * 症状是「点了没反应、没有报错、数据没保存」，且最难查（无任何日志）。
                 * PDF 那边同一个坑已经防过（见 PdfViewer 的浮动按钮）。
                 */
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => void createMark()}
              >
                {t('mark.button')}
              </button>
            </div>
          )}
          <aside className={marksOpen ? 'dsh-reading-markdrawer dsh-reading-markdrawer-open' : 'dsh-reading-markdrawer'} aria-label={t('mark.drawer')}>
            <header className="dsh-reading-markdrawer-head">
              <span className="dsh-reading-markdrawer-title">
                {t('mark.drawer')} · {marks.length} {t('mark.count')}
              </span>
              <button type="button" className="dsh-reading-iconbtn" onClick={() => setMarksOpen(false)} aria-label={t('mark.drawer')}>
                ×
              </button>
            </header>
            {marks.length === 0 ? (
              <p className="dsh-reading-markdrawer-empty">{t('mark.empty')}</p>
            ) : (
              <ul className="dsh-reading-marklist">
                {marks.map((mark) => (
                  <li key={mark.id} className="dsh-reading-markitem">
                    <blockquote className="dsh-reading-markquote">{mark.text}</blockquote>
                    <MarkNote mark={mark} placeholder={t('mark.notePlaceholder')} onSaveNote={(note) => updateMarkNote(mark.id, note)} />
                    <div className="dsh-reading-markitem-actions">
                      {/* 定位按钮：章节书要有 chapter 锚点；txt 只要切出了多个虚拟单元就能定位 */}
                      {(chaptered
                        ? parseMarkAnchor(mark.anchor)?.chapter !== undefined
                        : txtUnits.length > 1) && (
                        <button type="button" className="dsh-reading-iconbtn" onClick={() => jumpToMark(mark)}>
                          {t('mark.jump')}
                        </button>
                      )}
                      <button type="button" className="dsh-reading-iconbtn dsh-reading-markdelete" onClick={() => void removeMark(mark.id)}>
                        {t('mark.delete')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          <footer className="dsh-reading-statusbar">
            <button
              type="button"
              className="dsh-reading-iconbtn"
              title={unitBased ? t('reader.prev') : t('reader.prevPage')}
              disabled={view === 0 && (!unitBased || prevUnitIndex === undefined)}
              onClick={prevPage}
            >
              ‹
            </button>
            <span className="dsh-reading-pager">
              {unitBased ? `${t('reader.chapter')} ${visibleChapterPosition}/${selectableUnits.length} · ` : ''}
              {view + 1}/{pagination.viewCount} {t('reader.page')}
            </span>
            <div className="dsh-reading-progressbar" aria-hidden="true">
              <div className="dsh-reading-progressbar-fill" style={{ width: `${currentPercent}%` }} />
            </div>
            <span className="dsh-reading-percent">{Math.round(currentPercent)}%</span>
            <button
              type="button"
              className="dsh-reading-iconbtn"
              title={unitBased ? t('reader.next') : t('reader.nextPage')}
              disabled={view + 1 >= pagination.viewCount && (!unitBased || nextUnitIndex === undefined)}
              onClick={nextPage}
            >
              ›
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

/** 恢复页码工具的再导出（测试用）。 */
export { restoreView };

/** 单条划线的笔记编辑（失焦保存；空笔记不显示输入框以外的内容）。 */
function MarkNote({
  mark,
  placeholder,
  onSaveNote,
}: {
  mark: Highlight;
  placeholder: string;
  onSaveNote(note: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mark.note ?? '');
  if (!editing && (mark.note === undefined || mark.note === '')) {
    return (
      <button
        type="button"
        className="dsh-reading-markaddnote"
        onClick={() => {
          setDraft(mark.note ?? '');
          setEditing(true);
        }}
      >
        + {placeholder.replace(/…（可选）/, '').replace(/… \(optional\)/, '').trim()}
      </button>
    );
  }
  if (!editing) {
    return (
      <p
        className="dsh-reading-marknote"
        onClick={() => {
          setDraft(mark.note ?? '');
          setEditing(true);
        }}
      >
        {mark.note}
      </p>
    );
  }
  return (
    <textarea
      className="dsh-reading-marknote-input"
      value={draft}
      placeholder={placeholder}
      autoFocus
      rows={2}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== (mark.note ?? '')) onSaveNote(draft);
      }}
      onKeyDown={(event) => {
        // Enter 保存（Shift+Enter 换行）；Esc 放弃
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          (event.target as HTMLTextAreaElement).blur();
        }
        if (event.key === 'Escape') {
          setDraft(mark.note ?? '');
          setEditing(false);
        }
      }}
    />
  );
}
