/**
 * TXT 段落布局：把 TXT 原文切成「中文小说段落」，并给出「渲染文本 ↔ 原文偏移」双向映射。
 *
 * 背景（2026-10-19 TXT 排版改造 P0）：
 * 阅读器过去把 TXT 塞进 `<pre>` + `white-space: pre-wrap`，源文件换行被原样保留 ——
 * 老 txt 常见「每行 35~50 字硬折行」，一段被劈成好几行；新 txt 常见「一段一行」，
 * 又没有段间距。本模块把折行合并成真实段落，段落边界改由 `<p>` 结构表达。
 *
 * 四条设计约束（都是踩出来的，别轻改）：
 *
 * 1. **判据是「句子有没有说完」，不是行长统计。** 反例：`我和我的妹妹雯雯.txt`
 *    行长几乎恒为 34 字（形态上极像折行），但每行行尾都是 `。`，实际是短段落；
 *    任何「行长接近就合并」的启发式都会把这本书的段落搅乱 ——
 *    判据误伤（把短段落型书黏成一片）比漏合并严重得多。
 *
 * 2. **一律删除换行符**，`renderText` 内不含任何 `\n`（也不含 `\r`）。渲染走 `<p>` 结构，
 *    换行若留在文本里就会与 DOM 的 textContent 不一致：HTML 解析器会规范化掉 `\r`，
 *    段落标签之间的 `\n` 也会被折叠。而划线定位依赖
 *    「`renderText` === 所有文本节点拼接」这条不变量。
 *
 * 3. **删除即记账。** 每个被删字符的位置都进 `removedPositions`（升序），
 *    偏移映射完全由它推导，不再二次遍历原文。反过来，**没有进 removedPositions 的字符
 *    必须原样出现在 renderText 里** —— 这是 `renderText === 反转义(去标签(html))` 的保证。
 *
 * 4. **只按 `\n` 切行，`\r` 单独当「必删字符」处理。** 老 Mac 风格的行分隔 `\r` 不另立行，
 *    删掉后前后文本直接相连；这样 CRLF / LF / CR 三种源文件走同一条路径。
 *
 * 偏移基数 = 传入的 `text`。调用方传的是「单元文本」（`splitTextUnits` 切出的 unit.text），
 * 所以这里返回的都是**单元内偏移**；全书偏移的换算由调用方按 unit.start 叠加。
 */

/** 重排模式：`auto` 按判据合并折行，`preserve` 保留原样（每行独立成段）。 */
export type TxtReflowMode = 'auto' | 'preserve';

/** 源文件形态（供调试与 UI 提示，不参与排版决策）。 */
export type TxtShape = 'hard-wrap' | 'paragraph' | 'no-break' | 'preserve';

/** 一个段落的原文区间与渲染区间。 */
export interface TxtParagraph {
  /** 原文起点（含）。区间内包含被删除的字符（段首缩进、折行处的换行与行尾空白）。 */
  fullStart: number;
  /** 原文终点（不含）。 */
  fullEnd: number;
  /** 渲染文本起点（含）。 */
  renderStart: number;
  /** 渲染文本终点（不含）。 */
  renderEnd: number;
}

/** 布局统计。 */
export interface TxtLayoutStats {
  /**
   * 非空行数。口径与 `docs/diag-txt-linebreak/segment-replay.py` 的 `rawLines` 一致
   * （即 `text.split('\n')` 后 `trim()` 非空的行数），shape 判据的分母也用它。
   */
  rawLines: number;
  /** 段落数。 */
  paragraphCount: number;
  /**
   * 因「折行合并」而删掉的换行数。`preserve` 模式恒为 0。
   *
   * ⚠️ 它与 `removedPositions` 的口径**不同，别混用**：
   * - 本字段只统计「判定为折行、把两行接回一段」的换行（段边界换行、`\r`、段首缩进、行尾空白都不计）；
   * - `removedPositions` 则包含**全部**被删字符的位置（所有 `\n`、所有 `\r`、段首缩进、折行处行尾空白）。
   * 后者是偏移映射所必需 —— 渲染文本里一个换行都不能有，preserve 下每行独立成段，
   * 行间的 `\n` 照样要删，只是那些不算「合并」。
   */
  removedBreaks: number;
  /** 源文件形态。 */
  shape: TxtShape;
}

/** 布局结果。 */
export interface TxtLayout {
  /** 每段一个 `<p>…</p>`，段内已转义、段内无换行。 */
  html: string;
  /** 渲染文本：`html` 去标签反转义后的结果，等于 DOM 全部文本节点拼接，不含任何换行符。 */
  renderText: string;
  /** 段落列表（升序、不重叠）。 */
  paragraphs: TxtParagraph[];
  /** 被删除字符在原文中的位置（升序）。 */
  removedPositions: number[];
  /** 统计。 */
  stats: TxtLayoutStats;
}

/** 无条件句末标点（段边界判据 4 之一）。`…` 省略号与右括号族都算「句子已说完」。 */
const SENT_END = '。！？…】》!?~';

/**
 * 右引号家族。它**不能**无条件充当句末标点（见 `isSentenceEnd`）：
 * 全库实测行尾右引号 486 处，其中 284 处是「引号内句子已完整、该断」（`。」` `！」` `？」`），
 * 202 处是「引号内被硬折、该合并」（`，」` `好」`）。只看末字符会把那 202 处也断掉。
 */
const TRAILING_QUOTES = '」』”’';

/** 段首引号家族：下一行以它开头 → 段边界（对白起新段信号，类比「下一行以缩进开头」）。 */
const LEADING_QUOTES = '「“『‘';

/**
 * 兜底切段的硬上限：单段累积超过这么多字仍未断，就按句末标点强制切。
 * 为「整篇几乎没有换行」的 txt 准备（实测《蓝天航空公司的空姐》有 101546 字一行）。
 */
const MAX_PARA_CHARS = 800;

/** 兜底切段的目标下限：攒够这么多字再遇到句末标点就切，避免切出一地碎段。 */
const MIN_PARA_CHARS = 400;

/** 单行超过这么多字符 → 认定源文件几乎不换行（shape='no-break'）。 */
const NO_BREAK_MAX_LINE = 8000;

/** 平均每个非空行的字符数超过这么多 → 同上。 */
const NO_BREAK_CHARS_PER_LINE = 2000;

/** 折行合并率（removedBreaks / 非空行数）超过这个值 → 认定源文件是硬折行排版。 */
const HARD_WRAP_RATIO = 0.15;

/** 空白判定（与 `String.prototype.trim` 同源：含 \u3000 全角空格与 \uFEFF）。 */
const LINE_WS = /\s/;

const CODE_CR = 13;
const CODE_SPACE = 32;
const CODE_IDEOGRAPHIC_SPACE = 0x3000;

/**
 * HTML 转义。只处理 `&`、`<`、`>`，与 `ReaderView.tsx` 的 `escapeHtml` 同语义 ——
 * 转义后字符串里不可能出现标签，因此不需要再过 DOMPurify
 * （对几十万字跑一遍消毒是纯开销，实测 80ms 量级）。
 */
export function escapeHtmlText(source: string): string {
  // 绝大多数段落里没有这三个字符，先探一遍可省掉三次全量 replace。
  if (source.indexOf('&') === -1 && source.indexOf('<') === -1 && source.indexOf('>') === -1) {
    return source;
  }
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 判断一个行尾字符是否构成「句子已经说完」。
 *
 * 右引号家族（`」』”’`）必须**紧邻的前一个字符也是句末标点**才算 —— 否则
 * `，」`（引号内话没说完，被硬折）会被误断，把一份长对白切碎。
 * @param last - 去掉行尾空白后的最后一个字符。
 * @param prev - 紧邻它的前一个字符（必须落在**同一逻辑行**内）；不存在时传 undefined。
 */
function isSentenceEnd(last: string, prev: string | undefined): boolean {
  if (SENT_END.indexOf(last) >= 0) return true;
  if (TRAILING_QUOTES.indexOf(last) >= 0) {
    return prev !== undefined && SENT_END.indexOf(prev) >= 0;
  }
  return false;
}

/**
 * 切分并布局 TXT 文本。
 * @param text - 单元文本（偏移基数就是它）。
 * @param mode - `auto`（默认）合并折行；`preserve` 每个非空行独立成段。
 * @returns 布局结果（html / renderText / 段落区间 / 被删位置 / 统计）。
 */
export function layoutTxt(text: string, mode: TxtReflowMode = 'auto'): TxtLayout {
  const preserve = mode === 'preserve';
  const length = text.length;
  /** 全文有没有 `\r`：没有就走零开销快路径（绝大多数文件是纯 LF）。 */
  const hasCr = text.indexOf('\r') !== -1;

  const removed: number[] = [];
  const paras: TxtParagraph[] = [];
  const paraTexts: string[] = [];
  let renderLen = 0;
  let removedBreaks = 0;
  let nonBlankLines = 0;
  let maxLineLength = 0;

  // ── 当前段落缓冲 ──
  /** < 0 表示当前没有打开的段落。 */
  let paraFullStart = -1;
  let paraFullEnd = 0;
  let paraRenderStart = 0;
  let paraParts: string[] = [];

  /** 追加已保留的片段（数组 + join，避免 O(n²) 字符串拼接）。 */
  const pushKept = (chunk: string): void => {
    if (chunk === '') return;
    paraParts.push(chunk);
  };

  /**
   * 把原文 [from, to) 里**保留**的字符追加进当前段落缓冲。
   * 其中的 `\r` 无条件删除：HTML 解析器会吞掉 `\r`，留着它 renderText 就与 DOM textContent 对不上。
   */
  const appendKept = (from: number, to: number): void => {
    if (to <= from) return;
    if (!hasCr) {
      pushKept(text.slice(from, to));
      return;
    }
    let cut = from;
    for (let p = from; p < to; p += 1) {
      if (text.charCodeAt(p) === CODE_CR) {
        pushKept(text.slice(cut, p));
        removed.push(p);
        cut = p + 1;
      }
    }
    pushKept(text.slice(cut, to));
  };

  /**
   * 删除 [from, to) 的全部字符并记账。
   * 全程从左到右调用（段首缩进 → 段体 → 行尾空白 → 换行），因此 `removed` 天然升序。
   */
  const dropRange = (from: number, to: number): void => {
    for (let p = from; p < to; p += 1) removed.push(p);
  };

  /** 收口当前段落；未打开段落时是空操作。 */
  const flushPara = (): void => {
    if (paraFullStart < 0) return;
    const body = paraParts.length === 0 ? '' : paraParts.length === 1 ? (paraParts[0] ?? '') : paraParts.join('');
    paras.push({
      fullStart: paraFullStart,
      fullEnd: paraFullEnd,
      renderStart: paraRenderStart,
      renderEnd: paraRenderStart + body.length,
    });
    paraTexts.push(body);
    renderLen += body.length;
    paraFullStart = -1;
    paraParts = [];
  };

  /** [start, end) 是否只含空白（空行判据）。 */
  const isBlankLine = (start: number, end: number): boolean => {
    for (let p = start; p < end; p += 1) {
      if (!LINE_WS.test(text.charAt(p))) return false;
    }
    return true;
  };

  /**
   * 行首缩进的终点（无缩进时返回 start）。
   * 缩进判据：行首是 `\u3000`（全角空格），或 ≥2 个半角空格。
   * 只剥 `\u3000` 与半角空格，**不**剥 `\t` —— `\t` 开头在中文 txt 里形态未经验证，宁可不动。
   */
  const indentEndOf = (start: number, end: number): number => {
    const first = text.charCodeAt(start);
    const indented =
      first === CODE_IDEOGRAPHIC_SPACE || (first === CODE_SPACE && text.charCodeAt(start + 1) === CODE_SPACE);
    if (!indented) return start;
    let p = start;
    while (p < end) {
      const code = text.charCodeAt(p);
      if (code === CODE_IDEOGRAPHIC_SPACE || code === CODE_SPACE) p += 1;
      else break;
    }
    return p;
  };

  /** 行内容去掉行尾空白后的终点（判据「本行去掉行尾空白后以句末标点结尾」用它）。 */
  const bodyEndOf = (start: number, end: number): number => {
    let p = end;
    while (p > start && LINE_WS.test(text.charAt(p - 1))) p -= 1;
    return p;
  };

  let lineStart = 0;
  while (lineStart < length) {
    const nlIndex = text.indexOf('\n', lineStart);
    const hasNewline = nlIndex !== -1;
    const lineEnd = hasNewline ? nlIndex : length;
    const nextStart = hasNewline ? nlIndex + 1 : length;

    if (isBlankLine(lineStart, lineEnd)) {
      // 空行不属于任何段落：其中残留的空白字符也必须删掉。
      // 若留在 renderText 里，这些字符就没有任何元素承载 → 与「html 去标签」的结果不等。
      flushPara();
      dropRange(lineStart, lineEnd);
      if (hasNewline) dropRange(nlIndex, nlIndex + 1);
      lineStart = nextStart;
      continue;
    }

    nonBlankLines += 1;
    if (lineEnd - lineStart > maxLineLength) maxLineLength = lineEnd - lineStart;

    const indentEnd = indentEndOf(lineStart, lineEnd);
    const bodyEnd = bodyEndOf(lineStart, lineEnd);

    // 行首缩进 = 新段开始（auto 模式）。这与「下一行以缩进开头 → 段边界」等价：
    // 上一行处理时已因「下一行缩进」而收口，所以这里看到缩进时当前段必是上一段。
    if (!preserve && paraFullStart >= 0 && indentEnd > lineStart) flushPara();

    const isParaStart = paraFullStart < 0;
    if (isParaStart) {
      paraFullStart = lineStart;
      paraRenderStart = renderLen;
    }

    let keepFrom = lineStart;
    if (isParaStart && indentEnd > lineStart) {
      // 段首缩进剥掉：渲染层统一用 `text-indent: 2em`，留着就成双缩进。
      dropRange(lineStart, indentEnd);
      keepFrom = indentEnd;
    }
    appendKept(keepFrom, bodyEnd);
    paraFullEnd = lineEnd;

    // 段边界 vs 折行：先命中先断，下面的顺序就是优先级。
    let boundary = true;
    if (!preserve && hasNewline && nextStart < length) {
      const nextNl = text.indexOf('\n', nextStart);
      const nextEnd = nextNl === -1 ? length : nextNl;
      if (isBlankLine(nextStart, nextEnd)) {
        boundary = true; // 2) 下一行是空行
      } else if (indentEndOf(nextStart, nextEnd) > nextStart) {
        boundary = true; // 3) 下一行以缩进开头（新段信号）
      } else if (LEADING_QUOTES.indexOf(text.charAt(nextStart)) >= 0) {
        boundary = true; // 4) 下一行以引号开头（对白起新段，否则连续对白会黏成一段）
      } else {
        // 5) 本行句子已说完 → 段边界；否则 6) 折行（删掉换行接回上一行）
        const prev = bodyEnd - 2 >= lineStart ? text.charAt(bodyEnd - 2) : undefined;
        boundary = bodyEnd > lineStart && isSentenceEnd(text.charAt(bodyEnd - 1), prev);
      }
    }

    if (boundary) {
      // 段边界的行尾空白**保留**（契约只要求删折行处的行尾空白），但 `\r` 永远删。
      appendKept(bodyEnd, lineEnd);
      if (hasNewline) dropRange(nlIndex, nlIndex + 1);
      flushPara();
    } else {
      removedBreaks += 1;
      // 折行：行尾空白连同换行一起删，否则 renderText 里会留下断句处的空格。
      dropRange(bodyEnd, lineEnd);
      if (hasNewline) dropRange(nlIndex, nlIndex + 1);
      // 段落保持打开，下一行接上。
    }

    lineStart = nextStart;
  }
  flushPara();

  // ── 兜底：超长段落按句末标点强制切 ──
  // 整篇几乎没有换行的 txt 会产出一个巨大段落（10 万字量级），一列排版就是几万像素。
  // 切点必须落回原文，才能继续维持「渲染区间 ↔ 原文区间」的记账关系，
  // 所以这里重走一遍原文并跳过段内被删字符。只在确实存在超长段时执行，总代价 O(n)。
  let finalParas = paras;
  let finalTexts = paraTexts;
  if (!preserve) {
    let hasLongPara = false;
    for (const body of paraTexts) {
      if (body.length > MAX_PARA_CHARS) {
        hasLongPara = true;
        break;
      }
    }
    if (hasLongPara) {
      const outParas: TxtParagraph[] = [];
      const outTexts: string[] = [];
      // removed 升序且段落区间也升序，用一个单调指针即可，不必每段二分。
      let rj = 0;
      for (let i = 0; i < paras.length; i += 1) {
        const para = paras[i];
        // `noUncheckedIndexedAccess`：paras 与 paraTexts 始终同步 push，这里只是类型收窄，
        // 不影响任何切段/映射语义。
        if (para === undefined) continue;
        const body = paraTexts[i] ?? '';
        if (body.length <= MAX_PARA_CHARS) {
          outParas.push(para);
          outTexts.push(body);
          continue;
        }
        // 指针推进到本段区间内（被删字符可能落在段与段之间，比如空行的空白）。
        while ((removed[rj] ?? Number.NaN) < para.fullStart) rj += 1;

        let chunk: string[] = [];
        let chunkLen = 0;
        let chunkFullStart = para.fullStart;
        let chunkRenderStart = para.renderStart;
        /** 上一保留字符的原文位置（-1 = 本段尚无）：右引号判据只认「紧邻」的前一个字符。 */
        let prevKept = -1;
        for (let p = para.fullStart; p < para.fullEnd; p += 1) {
          while ((removed[rj] ?? Number.NaN) < p) rj += 1;
          if ((removed[rj] ?? Number.NaN) === p) {
            rj += 1; // 段内被删字符：跳过，但它的位置仍算在本块的 full 区间里
            continue;
          }
          const ch = text.charAt(p);
          const prevCh = prevKept === p - 1 ? text.charAt(prevKept) : undefined;
          chunk.push(ch);
          chunkLen += 1;
          // `。」` 这类要让引号跟着句末标点落在同一块里：句末标点后面紧跟右引号时推迟一个字符再切。
          const followedByQuote =
            SENT_END.indexOf(ch) >= 0 && TRAILING_QUOTES.indexOf(text.charAt(p + 1)) >= 0;
          const atSentenceEnd = isSentenceEnd(ch, prevCh) && !followedByQuote;
          if (chunkLen >= MAX_PARA_CHARS || (atSentenceEnd && chunkLen >= MIN_PARA_CHARS)) {
            // 硬切点不能落在代理对中间：`ch` 若正好是高代理项（U+D800~U+DBFF）且下一个码元是
            // 低代理项，就在**它之前**收口，把这一个字符（emoji / CJK 扩展 B 汉字）整个留给下一段。
            // 否则一个字符会被劈到两个 `<p>` 里，UI 渲染成两个替换字形。
            // 注意是「提前一个码元」而不是「多收一个码元」：这样段长仍 ≤ 800 码元，
            // 不破坏「每段 ≤ 800 字」的硬约束。
            let cutEnd = p + 1;
            let cutLen = chunkLen;
            let carried: string | undefined;
            const code = text.charCodeAt(p);
            if (cutEnd < para.fullEnd && code >= 0xd800 && code <= 0xdbff) {
              const next = text.charCodeAt(cutEnd);
              if (next >= 0xdc00 && next <= 0xdfff) {
                carried = ch;
                chunk.pop();
                cutLen -= 1;
                cutEnd = p;
              }
            }
            outTexts.push(chunk.join(''));
            outParas.push({
              fullStart: chunkFullStart,
              fullEnd: cutEnd,
              renderStart: chunkRenderStart,
              renderEnd: chunkRenderStart + cutLen,
            });
            chunkRenderStart += cutLen;
            chunk = carried === undefined ? [] : [carried];
            chunkLen = carried === undefined ? 0 : 1;
            chunkFullStart = cutEnd;
          }
          prevKept = p;
        }
        if (chunkLen > 0) {
          outTexts.push(chunk.join(''));
          outParas.push({
            fullStart: chunkFullStart,
            fullEnd: para.fullEnd,
            renderStart: chunkRenderStart,
            renderEnd: chunkRenderStart + chunkLen,
          });
        }
      }
      finalParas = outParas;
      finalTexts = outTexts;
    }
  }

  // ── 形态统计 ──
  // 注意：`removedBreaks` 是「被合并的折行数」，不是「被删的换行数」（见字段注释）。
  let shape: TxtShape;
  if (preserve) {
    shape = 'preserve';
  } else if (nonBlankLines === 0) {
    // 没有任何非空行：既谈不上行形态也谈不上合并率，按最保守的 'paragraph' 报。
    shape = 'paragraph';
  } else if (maxLineLength > NO_BREAK_MAX_LINE || length / nonBlankLines > NO_BREAK_CHARS_PER_LINE) {
    shape = 'no-break';
  } else if (removedBreaks / nonBlankLines > HARD_WRAP_RATIO) {
    shape = 'hard-wrap';
  } else {
    shape = 'paragraph';
  }

  const renderText = finalTexts.join('');
  const html = finalTexts.length === 0 ? '' : finalTexts.map((body) => `<p>${escapeHtmlText(body)}</p>`).join('');

  return {
    html,
    renderText,
    paragraphs: finalParas,
    removedPositions: removed,
    stats: {
      rawLines: nonBlankLines,
      paragraphCount: finalParas.length,
      removedBreaks,
      shape,
    },
  };
}

/** 二分：升序数组里 `< value` 的元素个数。 */
function countLess(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 二分：升序数组里 `<= value` 的元素个数。 */
function countLessOrEqual(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 原文偏移 → 渲染偏移。
 * 公式：`render = full - count(p_i < full)`。
 *
 * 落在**被删字符**上的 full 偏移会映射到「它右侧第一个保留字符在 renderText 中的下标」，
 * 因此 `renderText.slice(fullToRender(p))` 总是从 p 右侧第一个保留字符开始 ——
 * 划线锚点恰好落在换行/缩进上时，高亮从下一个可见字符起算，不会错位。
 * @param layout - 布局结果。
 * @param fullOffset - 原文偏移（超出范围会收敛到两端）。
 * @returns 渲染文本偏移。
 */
export function fullToRender(layout: TxtLayout, fullOffset: number): number {
  const total = layout.renderText.length + layout.removedPositions.length;
  // ⚠️ 已知限制（lead 2026-10-19 裁定「登记不修」）：`Number.isFinite` 把 ±Infinity 与 NaN 一并
  // 归为「非有限」而落到下界，于是 `fullToRender(∞)` = 0 却 `fullToRender(1e9)` = 文末，
  // 收敛方向不一致。调用点（阅读器 / 划线恢复）传的都是有限偏移，暂无影响；
  // 真要改需先确认没有调用点依赖 ∞ 的当前行为，所以这里只登记、不动。
  const raw = Number.isFinite(fullOffset) ? Math.trunc(fullOffset) : 0;
  const at = Math.min(Math.max(0, raw), total);
  return at - countLess(layout.removedPositions, at);
}

/**
 * 渲染偏移 → 原文偏移（`fullToRender` 的逆）。
 * 用二分找「第 renderOffset 个保留字符」：`countKept(<= f) > renderOffset` 的最小 f。
 * 末尾偏移（= renderText.length）返回原文长度，便于表示「到文末」。
 * @param layout - 布局结果。
 * @param renderOffset - 渲染文本偏移（超出范围会收敛到两端）。
 * @returns 原文偏移。
 */
export function renderToFull(layout: TxtLayout, renderOffset: number): number {
  const removed = layout.removedPositions;
  const total = layout.renderText.length + removed.length;
  // 与 fullToRender 同一处已知限制：NaN / ±Infinity 一律落到下界（lead 裁定登记不修）。
  const raw = Number.isFinite(renderOffset) ? Math.trunc(renderOffset) : 0;
  const target = Math.min(Math.max(0, raw), layout.renderText.length);
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const keptUpToMid = mid + 1 - countLessOrEqual(removed, mid);
    if (keptUpToMid > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
