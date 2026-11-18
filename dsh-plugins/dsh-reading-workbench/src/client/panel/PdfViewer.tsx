/**
 * PDF 阅读器：pdf.js 主线程渲染（fake worker，免独立 worker 文件）。
 * 数据经 /file 二进制路由取原始字节，canvas 逐页渲染。
 * 支持单页 / 双页并排（双页时以「跨页对」为单位翻页）与缩放。
 *
 * ## 划线（2026-10-20 新增）
 *
 * PDF 页面是 canvas 位图，**没有可选择的 DOM 文本**。划线的做法是：
 * 渲染时顺带取 `page.getTextContent()` 建**文字层**（每项的 viewport 坐标盒子），
 * 用户拖选后把选区矩形与这些盒子求交，得到页内字符偏移。
 * 坐标换算与判定逻辑在 `pdf-marks.ts` / `pdf-geometry.ts`（纯函数，已单测）。
 *
 * 锚点复用 `mark:` 格式，`ch` 字段装**页序号（0 起）** —— 与章节书的 chapter
 * 语义不同，但对定位来说同构（都是「先定位单元、再在单元内按字符偏移」），
 * 因此旧数据零迁移，`mark-anchor.ts` 一行都不用改。
 *
 * 高亮画在 canvas **上方**的一层绝对定位的 div 上（`pointer-events: none`），
 * 不污染 canvas 本身 —— 缩放、翻页、重新渲染都不会累积绘制。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// worker 模块注册到 globalThis 后 pdf.js 走主线程 fake worker（无需独立 worker 文件）
// @ts-expect-error pdf.worker 无类型入口
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import type { Highlight, ReaderColumns } from '../../shared/types.ts';
import { normalizeSelectionText } from '../../shared/mark-anchor.ts';
import { resolveColumns } from '../paginate.ts';
import {
  buildPageText,
  offsetFromRects,
  rectsForRange,
  type PdfPageText,
  type PdfTextItemLike,
} from '../pdf-marks.ts';
import { itemBox, toLocalRect } from '../pdf-geometry.ts';
import { FLOW_WHEEL_COOLDOWN_MS, FLOW_WHEEL_THRESHOLD } from './FlowReader.tsx';
// @ts-expect-error 全局挂载
globalThis.pdfjsWorker = pdfjsWorker;

/** 组件依赖。 */
export interface PdfViewerProps {
  fileUrl: string;
  columns: ReaderColumns;
  /** 初始页码（0 起）。 */
  initialPage?: number;
  /** 页码变化（用于保存进度）。 */
  onProgress?(page: number, pageCount: number): void;
  /** 本 PDF 的全部划线（锚点 `mark:ch=<页序号>:off=<页内偏移>:len=<长度>`）。 */
  marks?: Highlight[];
  /** 用户在页面上划线：给出页序号（0 起）、页内偏移、长度与选中文本。 */
  onCreateMark?(page: number, offset: number, length: number, text: string): void;
}

/** pdf.js 的页面对象（只用到渲染与文字层相关成员）。 */
interface PdfPageLike {
  getViewport(options: { scale: number }): {
    width: number;
    height: number;
    transform: number[];
    scale: number;
  };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
}

/** 解析 `mark:ch=N:off=M:len=L` 里的页序号与偏移（只认本插件写出的格式）。 */
export function parsePdfMark(anchor: string): { page: number; offset: number; length: number } | undefined {
  if (!anchor.startsWith('mark:')) return undefined;
  const fields = new Map<string, number>();
  for (const chunk of anchor.split(':')) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const value = Number(chunk.slice(eq + 1));
    if (Number.isFinite(value) && value >= 0) fields.set(chunk.slice(0, eq), Math.trunc(value));
  }
  const page = fields.get('ch');
  const offset = fields.get('off');
  const length = fields.get('len');
  if (page === undefined || offset === undefined || length === undefined) return undefined;
  return { page, offset, length };
}

/** 单页：canvas + 文字层 + 高亮层。 */
function PdfSheet({
  doc,
  pageNumber,
  scale,
  onRendered,
  marks,
  onPickRect,
}: {
  doc: { getPage(n: number): Promise<unknown> } | null;
  /** pdf.js 的页码（1 起）。 */
  pageNumber: number;
  scale: number;
  onRendered?(): void;
  /** 本页的划线（已按页过滤）。 */
  marks: Array<Highlight & { offset: number; length: number }>;
  /**
   * 选区变化时回报本页的选区矩形与文字层。
   * 父级据此决定「划线按钮画在哪、用哪一页的文字层算偏移」——
   * 双页模式下一页的报告会覆盖另一页的，这正是我们要的（用户只在其中一页拖选）。
   * 传 undefined 表示本页没有选区。
   * `offset` 是 canvas 相对滚动容器的左/上偏移（浮动按钮要用容器坐标系）。
   */
  onPickRect?(
    hit:
      | {
          rects: Array<{ left: number; top: number; right: number; bottom: number }>;
          pageText: PdfPageText;
          offset: { left: number; top: number };
        }
      | undefined,
  ): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageText, setPageText] = useState<PdfPageText | undefined>(undefined);
  /** 浏览器原生选区覆盖在本页时置位（有选区就不翻页）。 */
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (doc === null || pageNumber < 1) return;
      try {
        const pdfPage = (await doc.getPage(pageNumber)) as PdfPageLike;
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (canvas === null || cancelled) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (context === null) return;
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        if (cancelled) return;

        // ── 文字层：划线定位的唯一依据 ──
        // 换算到 viewport 空间后存包围盒；失败只影响划线，不影响阅读。
        try {
          const content = await pdfPage.getTextContent();
          if (cancelled) return;
          const items: PdfTextItemLike[] = [];
          for (const raw of content.items) {
            const str = typeof raw.str === 'string' ? raw.str : '';
            const transform = Array.isArray(raw.transform) ? (raw.transform as number[]) : [];
            if (transform.length < 6) continue;
            items.push({
              str,
              box: itemBox(
                { str, transform, width: typeof raw.width === 'number' ? raw.width : 0 },
                viewport.transform,
                viewport.scale,
              ),
            });
          }
          setPageText(buildPageText(items));
        } catch {
          // 文字层不可用时划线不可用，但页面照常显示（不把整页判成失败）
          setPageText(undefined);
        }
        if (!cancelled) onRendered?.();
      } catch {
        // 单页渲染失败不影响其他页（翻页会重试）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, onRendered]);

  /** 选区变化：把 DOM 选区换算成本页矩形并回报。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const sync = (): void => {
      const selection = window.getSelection();
      const text = selection?.toString() ?? '';
      if (selection === null || selection.rangeCount === 0 || text.trim() === '') {
        setHasSelection(false);
        onPickRect?.(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      // 选区必须在本 canvas 内（双页时可能跨到另一页，那种情况两页各算各的）
      const canvasRect = canvas.getBoundingClientRect();
      const rects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        // 与 canvas 有交集才算本页
        if (rect.right < canvasRect.left || rect.left > canvasRect.right) continue;
        if (rect.bottom < canvasRect.top || rect.top > canvasRect.bottom) continue;
        rects.push(toLocalRect(rect, canvasRect));
      }
      const hit = rects.length > 0;
      setHasSelection(hit);
      // 文字层还没就绪时不报告（划线按钮点了也算不出偏移，不如不出现）
      if (hit && pageText !== undefined) {
        // canvas 在本页容器内的位置：本 sheet 是 canvas 的直接包裹，
        // 因此相对偏移就是 canvas 相对 sheet 的左上角（通常为 0，但保留计算以防布局变化）。
        const sheetRect = canvas.parentElement?.getBoundingClientRect() ?? canvasRect;
        onPickRect?.({
          rects,
          pageText,
          offset: { left: canvasRect.left - sheetRect.left, top: canvasRect.top - sheetRect.top },
        });
      } else {
        onPickRect?.(undefined);
      }
    };

    document.addEventListener('selectionchange', sync);
    return () => document.removeEventListener('selectionchange', sync);
  }, [onPickRect, pageText]);

  /** 本页要高亮的矩形（由锚点恢复）。 */
  const highlightRects = useMemo(() => {
    if (pageText === undefined || marks.length === 0) return [];
    const out: Array<{ id: string; box: [number, number, number, number] }> = [];
    for (const mark of marks) {
      for (const box of rectsForRange(pageText, mark.offset, mark.length)) {
        out.push({ id: mark.id, box });
      }
    }
    return out;
  }, [marks, pageText]);

  return (
    <div className="dsh-reading-pdfsheet" data-has-selection={hasSelection ? 'true' : 'false'}>
      <canvas ref={canvasRef} className="dsh-reading-pdf-canvas" />
      {highlightRects.length > 0 && (
        <div className="dsh-reading-pdfmarks" aria-hidden="true">
          {highlightRects.map(({ id, box }, index) => (
            <span
              key={`${id}-${index}`}
              className="dsh-reading-pdfmark"
              data-dsh-mark-id={id}
              style={{
                left: `${box[0]}px`,
                top: `${box[1]}px`,
                width: `${Math.max(1, box[2] - box[0])}px`,
                height: `${Math.max(1, box[3] - box[1])}px`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** PDF 阅读器。 */
export function PdfViewer({
  fileUrl,
  columns,
  initialPage = 0,
  onProgress,
  marks = [],
  onCreateMark,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  /** 单页模式下的页码；双页模式下是该「跨页对」的首页码（1 起）。 */
  const [page, setPage] = useState(Math.max(1, initialPage + 1));
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string>();
  const [containerWidth, setContainerWidth] = useState(0);
  const [ready, setReady] = useState(false);
  const docRef = useRef<{ getPage(n: number): Promise<unknown>; numPages: number } | null>(null);
  const [doc, setDoc] = useState<{ getPage(n: number): Promise<unknown> } | null>(null);
  /** 当前选中的矩形（决定是否显示「划线」按钮）。 */
  /**
   * 当前选区：来自**哪一页**（pdf 页码，1 起）、该页的选区矩形、该页的文字层。
   * 三者必须来自同一页 —— 用 A 页的矩形配 B 页的文字层会算出完全错误且不报错的偏移。
   * `anchor` 是选区在**容器坐标系**里的左上角，用于定位浮动按钮。
   */
  const [picked, setPicked] = useState<
    | {
        pageNumber: number;
        rects: Array<{ left: number; top: number; right: number; bottom: number }>;
        pageText: PdfPageText;
        anchor: { left: number; top: number };
      }
    | undefined
  >(undefined);

  /**
   * 子页回报选区。
   *
   * 同一页的覆盖、另一页的报告忽略（用户只在一页拖选）。
   * `rects` 是**canvas 本地坐标**，要加上 canvas 相对容器的偏移才能定位浮动按钮；
   * 这个偏移由子页一并给出（见 `onPickRect` 的 offset 字段）。
   */
  const pickFrom = useCallback(
    (
      pageNumber: number,
      hit:
        | {
            rects: Array<{ left: number; top: number; right: number; bottom: number }>;
            pageText: PdfPageText;
            offset: { left: number; top: number };
          }
        | undefined,
    ): void => {
      if (hit === undefined) {
        setPicked((current) => (current?.pageNumber === pageNumber ? undefined : current));
        return;
      }
      setPicked({
        pageNumber,
        rects: hit.rects,
        pageText: hit.pageText,
        anchor: hit.offset,
      });
    },
    [],
  );

  const spread = resolveColumns(columns, containerWidth) === 2;

  // ── 测量容器宽度（决定单页/双页）──
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => setContainerWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ── 载入文档 ──
  useEffect(() => {
    let cancelled = false;
    let activeTask: { destroy(): Promise<void> } | null = null;
    setReady(false);
    setError(undefined);
    (async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data });
        activeTask = loadingTask;
        const loaded = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        docRef.current = loaded;
        setDoc(loaded);
        setNumPages(loaded.numPages);
        setPage((current) => Math.min(Math.max(1, current), Math.max(1, loaded.numPages)));
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
      void activeTask?.destroy();
      docRef.current = null;
      setDoc(null);
    };
  }, [fileUrl]);

  // ── 上报进度 ──
  useEffect(() => {
    if (numPages > 0 && ready) onProgress?.(page - 1, numPages);
  }, [numPages, onProgress, page, ready]);

  // ── 键盘翻页（与流式阅读器一致的手感）──
  const step = spread ? 2 : 1;
  const goNext = useCallback((): void => {
    setPage((current) => Math.min(numPages, current + step));
  }, [numPages, step]);
  const goPrev = useCallback((): void => {
    setPage((current) => Math.max(1, current - step));
  }, [step]);

  // ── 有选区时不翻页（用户正在选字，翻页会把选区弄丢）──
  const hasSelection = picked !== undefined;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        // 有选中文字时不翻页：用户多半想复制/划线
        if (hasSelection) return;
        event.preventDefault();
        goNext();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        if (hasSelection) return;
        event.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, hasSelection]);

  // ── 滚轮翻页（与流式阅读器同一套阈值/冷却，手感一致）──
  // 必须手动 addEventListener + passive: false，理由见 FlowReader 里的注释。
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let lastAt = 0;
    let accum = 0;
    const onWheel = (event: WheelEvent): void => {
      // 选字过程中滚轮交给浏览器（否则选区会被强行打断）
      if (hasSelection) return;
      event.preventDefault();
      const now = Date.now();
      if (accum !== 0 && Math.sign(event.deltaY) !== Math.sign(accum)) accum = 0;
      if (now - lastAt < FLOW_WHEEL_COOLDOWN_MS) return;
      accum += event.deltaY;
      if (Math.abs(accum) < FLOW_WHEEL_THRESHOLD) return;
      const direction = accum > 0 ? 1 : -1;
      accum = 0;
      lastAt = now;
      if (direction === 1) goNext();
      else goPrev();
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [goNext, goPrev, hasSelection]);

  /** 双页时右页页码（超出则空）。 */
  const rightPage = page + 1 <= numPages ? page + 1 : 0;

  /** 某页的划线（页序号 = pdf 页码 - 1）。 */
  const marksFor = useCallback(
    (pdfPageNumber: number): Array<Highlight & { offset: number; length: number }> => {
      const index = pdfPageNumber - 1;
      const out: Array<Highlight & { offset: number; length: number }> = [];
      for (const mark of marks) {
        const parsed = parsePdfMark(mark.anchor);
        if (parsed === undefined || parsed.page !== index) continue;
        out.push({ ...mark, offset: parsed.offset, length: parsed.length });
      }
      return out;
    },
    [marks],
  );

  if (error !== undefined) {
    return <p className="dsh-reading-error">PDF: {error}</p>;
  }

  return (
    <div className="dsh-reading-pdf" ref={containerRef}>
      <nav className="dsh-reading-pdfnav">
        <button type="button" className="dsh-reading-iconbtn" disabled={page <= 1} onClick={goPrev}>
          ‹
        </button>
        <span className="dsh-reading-pager">
          {numPages > 0 ? `${page}${spread && rightPage > 0 ? `–${rightPage}` : ''}/${numPages} ${''}` : '…'}
        </span>
        <button type="button" className="dsh-reading-iconbtn" disabled={page + step > numPages} onClick={goNext}>
          ›
        </button>
        <span className="dsh-reading-pdfsep" />
        <button type="button" className="dsh-reading-iconbtn" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>
          －
        </button>
        <span className="dsh-reading-pager">{Math.round(scale * 100)}%</span>
        <button type="button" className="dsh-reading-iconbtn" onClick={() => setScale((s) => Math.min(3, s + 0.2))}>
          ＋
        </button>
      </nav>
      <div className="dsh-reading-pdfpages" data-spread={spread ? 'two' : 'one'}>
        <PdfSheet
          doc={doc}
          pageNumber={page}
          scale={scale}
          marks={marksFor(page)}
          onPickRect={(hit) => pickFrom(page, hit)}
        />
        {spread && rightPage > 0 && (
          <PdfSheet
            doc={doc}
            pageNumber={rightPage}
            scale={scale}
            marks={marksFor(rightPage)}
            onPickRect={(hit) => pickFrom(rightPage, hit)}
          />
        )}
      </div>
      {/* 划线浮动按钮：有选区才出现。锚点是选区左上角（容器坐标系）。 */}
      {picked !== undefined && onCreateMark !== undefined && picked.rects[0] !== undefined && (
        <button
          type="button"
          className="dsh-reading-markpopup dsh-reading-markpopup-btn dsh-reading-pdfmarkbtn"
          style={{
            left: `${Math.max(8, picked.anchor.left + picked.rects[0].left)}px`,
            top: `${Math.max(4, picked.anchor.top + picked.rects[0].top - 36)}px`,
          }}
          onMouseDown={(event) => {
            // 按钮本身不能抢走选区
            event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            // 用**本选区所属那一页**的文字层算偏移（跨页混用会算出错误且不报错的锚点）
            const hit = offsetFromRects(picked.pageText, picked.rects);
            if (hit === undefined) return;
            const text = normalizeSelectionText(hit.text);
            if (text === '') return;
            onCreateMark(picked.pageNumber - 1, hit.offset, hit.length, text);
            window.getSelection()?.removeAllRanges();
            setPicked(undefined);
          }}
        >
          划线
        </button>
      )}
    </div>
  );
}
