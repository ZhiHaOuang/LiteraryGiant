/**
 * 分页阅读区（受控组件）。
 *
 * 排版原理：外层 viewport 固定宽高 + `overflow: hidden` 做裁切；内层 flow 用
 * CSS 多栏（`column-fill: auto` + 固定高度）把整篇内容排成 N 列并横向溢出。
 * 翻页即对内层施加 `translateX(-view * 步长)`。
 *
 * ⚠️ 两个量必须分清（曾经混用，导致每翻一屏偏移一个列间距，表现为"翻页不准确"）：
 * - **flow 宽度 = screenWidthOf**（一屏可见宽度 = 可见列宽 + 列之间那 1 个间距）；
 * - **翻页位移 = viewOffset → stepOf**（一屏跨过的实际距离 = 可见列数 × 列步进）。
 * 二者相差恰好一个 `COLUMN_GAP`：一屏右边界止于末列右缘，下一屏首列要从
 * 「末列右缘 + 间距」处起排。
 *
 * 因此「页码」是真实排版结果：改字号、改窗口宽度都会自动重排并重算页数。
 * 本组件只管排版与测量，翻页状态由父级持有（受控）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderColumns } from '../../shared/types.ts';
import {
  COLUMN_GAP,
  columnWidthOf,
  makePagination,
  resolveColumns,
  screenWidthOf,
  stepOf,
  type Pagination,
} from '../paginate.ts';

/**
 * 滚轮翻页阈值（累加 deltaY 的绝对值）。
 * 鼠标滚轮一格通常 100~120，触控板一次轻扫可能 1~5；
 * 100 让「滚一格 = 翻一页」，同时不被触控板的细碎事件误触发。
 */
export const FLOW_WHEEL_THRESHOLD = 100;

/** 滚轮翻页冷却（毫秒）：期间只认第一次，防止连发/惯性一次跳好几页。 */
export const FLOW_WHEEL_COOLDOWN_MS = 260;

/** 组件依赖。 */
export interface FlowReaderProps {
  /** 已消毒的 HTML（章节内容或渲染后的 Markdown）。 */
  html: string;
  /** 纯文本模式（TXT：保留空白与换行）。 */
  plain?: boolean;
  /**
   * 章节书模式（epub / mobi / web）。
   *
   * 与 `plain` 互斥：章节书是富文本（有 `<p>`/`<ol>`/`<blockquote>`），但**书内 CSS 可能为空**
   * （mobi、网页书、以及 CSS 解析失败时的降级）。这档样式负责「没有书内 CSS 时也像一本书」：
   * 段首缩进 + 段距 + 图片居中。书内 CSS 特异性更高，会把这里的规则盖掉——正是期望的行为。
   */
  book?: boolean;
  fontSize: number;
  lineHeight: number;
  /** 正文字体族（inline style 直接落到 flow 容器，子元素继承）。 */
  fontFamily?: string;
  columns: ReaderColumns;
  /** 当前屏号（受控）。 */
  view: number;
  /** true = 直接落位不做滑动动画（连续翻页/换章/重排时用）。 */
  instant?: boolean;
  /** 排版结果变化（测量完成 / 重排）。 */
  onPagination(pagination: Pagination): void;
  /** 章节内链接点击（EPUB 内部跳转）。 */
  onReaderClick?(event: React.MouseEvent<HTMLElement>): void;
  /** 选区松开（划线交互的入口；挂在未平移的视口上）。 */
  onReaderMouseUp?(event: React.MouseEvent<HTMLElement>): void;
  /** 滚轮翻页请求：+1 下一页 / -1 上一页（只能由宿主可滚轮绑定的非 passive 监听触发）。 */
  onWheelPage?(direction: 1 | -1): void;
  /** 把正文元素暴露给父级（划线高亮恢复需要操作 DOM）。 */
  flowRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** 内容 key：变化时触发重排测量。 */
  contentKey: string;
}

/** 分页阅读区。 */
export function FlowReader({
  html,
  plain = false,
  book = false,
  fontSize,
  lineHeight,
  fontFamily,
  columns,
  view,
  instant = false,
  onPagination,
  onReaderClick,
  onReaderMouseUp,
  onWheelPage,
  flowRef: externalFlowRef,
  contentKey,
}: FlowReaderProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const internalFlowRef = useRef<HTMLDivElement | null>(null);
  /**
   * 把 flow DOM 同时挂到内部 ref 与外部 ref（外部 ref 供划线恢复用）。
   *
   * ⚠️ **不要**改回 `ref={externalFlowRef}` + 一个“同步内部 ref 到外部”的 `useEffect`：
   * 那样每个 passive effect 都会把外部 ref 覆盖成内部 ref —— 而内部 ref 从未绑定过
   * DOM（永远是 null），于是 `measureFlow()` 从第二帧起全部 early return，
   * **图片加载完成 / 窗口缩放 / 字号变化后的重测全部失效**。
   * 症状：图片多的章节永远停在「首次测量时图片还没加载」的屏数，用户看到整章只有 1 页。
   */
  const attachFlow = useCallback(
    (element: HTMLDivElement | null): void => {
      internalFlowRef.current = element;
      if (externalFlowRef !== undefined) externalFlowRef.current = element;
    },
    [externalFlowRef],
  );
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollWidth, setScrollWidth] = useState(0);

  const columnsPerView = resolveColumns(columns, viewportWidth);
  const columnWidth = columnWidthOf(viewportWidth, columnsPerView);
  /** flow 宽度：一屏可见宽度（末列右缘就是这一屏的右边界）。 */
  const screenWidth = screenWidthOf(columnWidth, columnsPerView);
  /** 翻一屏的位移：比可见宽度多一个列间距，否则每屏累积偏移。 */
  const offset = view * stepOf(columnWidth, columnsPerView);

  // ── 测量：视口尺寸 ──
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const measure = (): void => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ── 测量：内容总宽（列数由此推出）──
  const measureFlow = useCallback(() => {
    const flow = internalFlowRef.current;
    if (flow === null) return;
    setScrollWidth(flow.scrollWidth);
  }, []);

  useLayoutEffect(() => {
    measureFlow();
    // 图片/字体加载会改变排版宽度：对内容区挂捕获阶段 load 监听补测，
    // 再叠加两次延迟补测兜底（不依赖任何第三方库）。
    const flow = internalFlowRef.current;
    if (flow === null) return;
    const onLoad = (): void => measureFlow();
    flow.addEventListener('load', onLoad, true);
    const timers = [120, 480].map((delay) => window.setTimeout(measureFlow, delay));
    return () => {
      flow.removeEventListener('load', onLoad, true);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [measureFlow, html, contentKey, fontSize, lineHeight, viewportWidth, viewportHeight, columnsPerView]);

  // ── 上报分页结果 ──
  const paginationKey = `${viewportWidth}:${viewportHeight}:${scrollWidth}:${columnsPerView}`;
  useEffect(() => {
    if (viewportWidth <= 0 || viewportHeight <= 0) return;
    onPagination(makePagination(viewportWidth, scrollWidth, columnsPerView));
    // paginationKey 聚合了全部输入，避免对象依赖导致的重复上报
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginationKey, onPagination]);

  // ── 滚轮翻页 ──
  //
  // 必须用 addEventListener 手动挂，且显式 `passive: false`：
  // React 的 onWheel 走浏览器默认的 passive 监听，里面调 preventDefault() 无效，
  // 会触发控制台告警并让外层（页面）跟着滚动。自己挂才能吃掉默认滚动。
  //
  // 阈值 + 冷却两个防抖缺一不可：
  // - 阈值：触控板会以极小 deltaY 高频连续发射，不设阈值一滑就跳十几页；
  // - 冷却：鼠标滚轮的连发/惯性同理，冷却期内只认第一次。
  //
  // 冷却期内**整段丢弃**（连累积也清掉），不留给后面补翻：
  // 留累积会让「一次大幅滚动后的残余事件」在冷却到期时再翻一页，
  // 表现为「滚一格翻两页」—— 恰好是加冷却想避免的事。
  // 用户真要连翻，冷却过期后继续滚即可，手感依然连续。
  //
  // 滚轮监听挂在**视口**上（与点击热区同一个未平移元素），不挂在内层 flow 上。
  const wheelState = useRef({ lastAt: 0, accum: 0 });
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || onWheelPage === undefined) return;
    const onWheel = (event: WheelEvent): void => {
      // 有文字选区时不翻页（用户正在选字）
      const selection = window.getSelection();
      if (selection !== null && selection.toString().trim() !== '') return;
      // 浮层内滚动（笔记抽屉等）交给它自己处理
      const target = event.target as HTMLElement | null;
      if (target !== null && target.closest('[data-dsh-scrollable]') !== null) return;

      event.preventDefault();
      const now = Date.now();
      const state = wheelState.current;
      // 冷却期：整段丢弃（不累积），防止残余事件在冷却到期时补翻一页
      if (now - state.lastAt < FLOW_WHEEL_COOLDOWN_MS) {
        state.accum = 0;
        return;
      }
      // 换方向立刻清零累积，避免「往回滑一点点却要攒满阈值」的粘滞感
      if (state.accum !== 0 && Math.sign(event.deltaY) !== Math.sign(state.accum)) state.accum = 0;
      state.accum += event.deltaY;
      if (Math.abs(state.accum) < FLOW_WHEEL_THRESHOLD) return;
      const direction: 1 | -1 = state.accum > 0 ? 1 : -1;
      state.accum = 0;
      state.lastAt = now;
      onWheelPage(direction);
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [onWheelPage]);

  return (
    <div
      className="dsh-reading-viewport"
      ref={viewportRef}
      data-columns={columnsPerView}
      // 点击热区挂在**未平移**的视口上：内层 flow 会随翻页左移，
      // 若挂在 flow 上，getBoundingClientRect().left 会变成负值，
      // 导致翻到后面时点左侧三分之一也算「右侧」——
      // 表现为「只能往后翻、不能往前翻」。
      onClick={onReaderClick}
      onMouseUp={onReaderMouseUp}
    >
      <div
        className={
          'dsh-reading-flow' +
          (plain ? ' dsh-reading-flow-plain' : '') +
          (book && !plain ? ' dsh-reading-flow-book' : '')
        }
        ref={attachFlow}
        data-instant={instant ? 'true' : undefined}
        style={{
          height: viewportHeight > 0 ? `${viewportHeight}px` : '100%',
          width: screenWidth > 0 ? `${screenWidth}px` : '100%',
          columnWidth: columnWidth > 0 ? `${columnWidth}px` : undefined,
          columnGap: `${COLUMN_GAP}px`,
          columnFill: 'auto',
          fontSize: `${fontSize}px`,
          lineHeight,
          ...(fontFamily === undefined ? {} : { fontFamily }),
          transform: `translateX(${-offset}px)`,
        }}
        // 内容已在上游用 DOMPurify 消毒（章节 HTML / marked 产物）
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
