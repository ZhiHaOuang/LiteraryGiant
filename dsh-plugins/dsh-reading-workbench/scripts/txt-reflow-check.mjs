/**
 * TXT 折行重排**独立对抗验收**（verifier 自建，不复用 T1 的 `txt-layout-selftest.mjs`）。
 *
 * 被验证对象：`src/client/txt-layout.ts`
 *   layoutTxt / fullToRender / renderToFull / escapeHtmlText
 *
 * 攻击面（对应 task-3）：
 *   1) 判据误伤：短段型书被误判成折行型 → 段落被搅乱（最严重）；
 *   2) 偏移映射差 1：划线会**静默**错位，不报错；
 *   3) DOM 级对拍：jsdom 解析 html 取文本节点拼接，断言 === renderText
 *      （`\r` 规范化、实体转义问题只在这一层暴露）；
 *   4) 代理对：emoji / 扩展汉字是 UTF-16 双码元，码点遍历实现会错位；
 *   5) 性能。
 *
 * 纪律：
 *   - 只读 `C:\Users\lihua\OneDrive\图书\`，**绝不把书籍正文写进仓库或打印**（只输出数字）；
 *   - 解码走插件同一入口 `src/shared/text-encoding.ts`，不自己发明一套；
 *   - 判定对口径折行率 = 合并数 / 判定对数（判定对 = 相邻两行都非空且下一行不以缩进开头的行对）。
 *
 * 用法：node plugins/reading-workbench/scripts/txt-reflow-check.mjs [--no-books]
 *   退出码 0 = 全部通过；非 0 = 存在失败项。
 */

import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  escapeHtmlText,
  fullToRender,
  layoutTxt,
  renderToFull,
} from '../src/client/txt-layout.ts';
import { DEFAULT_UNIT_CHARS, splitTextUnits } from '../src/client/txt-units.ts';
import { decodeTextBytes } from '../src/shared/text-encoding.ts';

// ────────────────────────── 断言框架 ──────────────────────────

let total = 0;
let failed = 0;
const failures = [];

/**
 * 打印一条断言。
 * @param name - 断言名。
 * @param condition - 是否通过。
 * @param detail - 实测值（务必给，报告要数字）。
 */
function check(name, condition, detail) {
  total += 1;
  if (!condition) {
    failed += 1;
    failures.push(name);
  }
  const suffix = detail === undefined ? '' : `  ${detail}`;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
}

/** 只记录不打印（用于大批量真实验收，避免刷屏）。 */
function quietCheck(name, condition, detail) {
  total += 1;
  if (!condition) {
    failed += 1;
    failures.push(`${name}  ${detail ?? ''}`);
    console.log(`FAIL  ${name}  ${detail ?? ''}`);
  }
  return condition;
}

// ────────────────────────── 通用工具 ──────────────────────────

/** 纯字符串版的「去 <p> 标签 + 反转义」。 */
function detachHtml(html) {
  return html
    .replace(/<\/p>/g, '')
    .replace(/<p>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * jsdom 解析 html，拼接**所有文本节点**（不是 textContent，避免依赖实现的差异）。
 * @param html - 段落 html。
 * @returns DOM 文本节点拼接结果。
 */
function domTextOf(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="host">${html}</div></body></html>`);
  const host = dom.window.document.getElementById('host');
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(child.nodeValue);
      else walk(child);
    }
  };
  walk(host);
  return { text: out.join(''), paragraphs: [...host.querySelectorAll('p')] };
}

/** 区间内被删字符个数（removed 升序，用二分）。 */
function removedInRange(removed, from, to) {
  const lower = (value) => {
    let lo = 0;
    let hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (removed[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return lower(to) - lower(from);
}

/**
 * 判据集合口径（**必须是 2026-10-19 Lead 裁定后的版本**）：
 * task-1 冻结契约的字面集合是 `。！？…”』】》!?~`，但裁定把右引号家族整体改为条件判定
 * （`」』”’` 需前置句末标点），因此 `”』` 不再无条件断段。
 * 实测影响：全库 119 处由「断」变「合并」（约 0.28%），明细见
 * `docs/diag-txt-linebreak/independent-impact-trailing-quotes.mjs`。
 */
const SENT_END = new Set([...'。！？…】》!?~']);
const TRAILING_QUOTES = new Set([...'」』”’']);
const LEADING_QUOTES = new Set([...'「“『‘']);
/** 最初契约（修订前）的无条件句末标点集合，用于识别「修订新增的段边界」。 */
const CONTRACT_SENT = new Set([...'。！？…”』】》!?~']);
/**
 * 「段落以标点起头」分两档，因为二者的语义强度完全不同：
 * - HARD：`，。、；：！？」』）】》”’` —— 段落**不可能**以这些字符开头，出现即证明切在了半句话里；
 * - SOFT：`…～-—·` —— 省略号/波浪号起段在中文网络小说里是常见的「语气停顿」写法，不构成缺陷，
 *   只统计上报（实测全库 6 本里仅 1 处：`准夫妻的性生活1-33.txt`，占该书新增断点 1/36 = 2.78%）。
 */
const LEADING_PUNCT_HARD = new Set([...'，。、；：！？”’」』）】》']);
const LEADING_PUNCT_SOFT = new Set([...'…～-—·']);
const isBlankLine = (line) => line.trim() === '';
const isIndented = (line) => line.startsWith('\u3000') || line.startsWith('  ');
const rtrim = (line) => line.replace(/[ \t\u3000]+$/, '');

/** 把文本按 `\n` 切成 [{start,end,nl}]（只按 \n，`\r` 不另立行）。 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      lines.push({ start, end: text.length, nl: -1 });
      break;
    }
    lines.push({ start, end: nl, nl });
    start = nl + 1;
  }
  return lines;
}

/**
 * **独立复算**判定结果（不调用被测实现），用于与实现的实际决策对拍。
 * 逐条按 task-1 契约 + 2026-10-19 修订实现。
 * @param text - 原文。
 * @returns 计数与逐行决策。
 */
function independentDecision(text) {
  const lines = splitLines(text);
  let merges = 0;
  let decisionPairs = 0;
  let sentBreaks = 0;
  let quoteBreaks = 0;
  let indentBreaks = 0;
  let blankBreaks = 0;
  /** 逐行判定（下标 = 行号；'eof' 表示没有下一行）。供逐对还原对拍使用。 */
  const verdicts = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    // CRLF 源文件：行尾的 `\r` 必须按实现的语义「删掉后前后相连」，否则末字符会误判成 `\r`。
    // 实测：全库 83 本**全部**是 CRLF（835463 个 \r\n），漏掉这一步会让预测数整体偏高。
    const lineText = text.slice(line.start, line.end).replace(/\r/g, '');
    const nextText = text.slice(next.start, next.end).replace(/\r/g, '');
    if (isBlankLine(lineText)) {
      verdicts.push('blank');
      continue;
    }
    if (isBlankLine(nextText)) {
      blankBreaks += 1;
      verdicts.push('next-blank');
      continue;
    }
    if (isIndented(nextText)) {
      indentBreaks += 1;
      verdicts.push('indent');
      continue;
    }
    decisionPairs += 1; // 到这里才是「可能合并」的判定对
    const right = rtrim(lineText);
    const first = nextText[0];
    if (first !== undefined && LEADING_QUOTES.has(first)) {
      quoteBreaks += 1;
      verdicts.push('quote');
      continue;
    }
    const last = right[right.length - 1];
    const prev = right.length >= 2 ? right[right.length - 2] : undefined;
    const sentEnd =
      last !== undefined &&
      (SENT_END.has(last) || (TRAILING_QUOTES.has(last) && prev !== undefined && SENT_END.has(prev)));
    if (right.length > 0 && sentEnd) {
      sentBreaks += 1;
      verdicts.push('sent');
      continue;
    }
    merges += 1;
    verdicts.push('merge');
  }
  return { merges, decisionPairs, sentBreaks, quoteBreaks, indentBreaks, blankBreaks, verdicts, lines };
}

/**
 * **逐对还原实现的真实决策**（前缀截断法），与独立复算逐行对拍。
 *
 * 原理：`M(prefix_k)` = 前 k 个行对（line i vs line i+1, i<k）的合并数累计 ——
 * prefix_k 只有 k+1 行且末行无换行（恒为段边界），所以
 * `decision(i) = M(prefix_{i+1}) - M(prefix_i)`。
 * 这样可以在**不读实现源码**的前提下把每一对的决定逐一还原，
 * 用来排除「聚合数相等但互相抵消」的假绿。
 * @param text - 单元文本。
 * @param verdicts - 独立复算的逐行判定。
 * @returns `{ pairs, diverged, first }`。
 */
function perPairOracle(text, verdicts) {
  const lines = splitLines(text);
  const prefixMerge = [];
  for (let k = 0; k < lines.length; k += 1) {
    const end = lines[k].nl === -1 ? text.length : lines[k].nl + 1;
    prefixMerge.push(layoutTxt(text.slice(0, end), 'auto').stats.removedBreaks);
  }
  let diverged = 0;
  let first = null;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const impl = prefixMerge[i + 1] - prefixMerge[i];
    const mine = verdicts[i] === 'merge' ? 1 : 0;
    if (impl !== mine) {
      diverged += 1;
      if (first === null) first = { line: i, impl, mine: verdicts[i] };
    }
  }
  return { pairs: Math.max(0, lines.length - 1), diverged, first };
}

/**
 * **最初契约**（2026-10-19 修订前）的判定：用于识别「本次修订新增的段边界」。
 * 最初契约：句末标点 = `。！？…”』】》!?~`（无条件），**没有**右引号条件规则，**没有**开引号规则。
 * 因此「新增断点」= 右引号条件规则（`」’` 前置句末标点）+ 开引号规则 + `”』` 改条件 三者的并集，
 * 与落地前 `docs/diag-txt-linebreak/independent-prediction-split.mjs` 的口径一致（全库 703 处 / ≈列宽 512 处）。
 * @returns 'merge' 或断段原因。
 */
function contractVerdict(lineText, nextText) {
  if (isBlankLine(lineText)) return 'blank';
  if (isBlankLine(nextText)) return 'next-blank';
  if (isIndented(nextText)) return 'indent';
  const right = rtrim(lineText);
  const last = right[right.length - 1];
  if (right.length > 0 && last !== undefined && CONTRACT_SENT.has(last)) return 'sent';
  return 'merge';
}

/**
 * 对一份文本跑完整不变量电池（每条一个断言）。
 * @param label - 断言名前缀。
 * @param text - 原文。
 * @param mode - 模式。
 * @param opts - `{ dom: boolean, exhaustiveRoundTrip: boolean, labelPrefix: string }`。
 * @returns layout。
 */
function invariants(label, text, mode = 'auto', opts = {}) {
  const { dom = true, exhaustiveRoundTrip = false, quiet = false } = opts;
  const say = quiet ? quietCheck : check;
  const layout = layoutTxt(text, mode);
  const removed = layout.removedPositions;

  // 1) removedPositions 严格升序（同时保证无重复）
  let ascending = true;
  for (let i = 1; i < removed.length; i += 1) if (!(removed[i] > removed[i - 1])) ascending = false;
  say(`${label}｜removedPositions 严格升序`, ascending, `n=${removed.length}`);

  // 2) 长度守恒：被删字符数 + 渲染字符数 === 原文长度（最强的一条）
  say(
    `${label}｜长度守恒 被删+渲染 === 原文`,
    removed.length + layout.renderText.length === text.length,
    `${removed.length}+${layout.renderText.length} vs ${text.length}`,
  );

  // 3) renderText 不含任何换行符
  say(`${label}｜renderText 无 \\n/\\r`, !/[\n\r]/.test(layout.renderText));

  // 4) html 内无换行（段内无 \n）
  say(`${label}｜html 内无换行`, !/[\n\r]/.test(layout.html));

  // 5) <p> 数 === 段落数
  const pCount = (layout.html.match(/<p>/g) || []).length;
  say(`${label}｜<p> 数 === 段落数`, pCount === layout.paragraphs.length, `${pCount} vs ${layout.paragraphs.length}`);

  // 6) renderText === 去 <p> 标签并反转义后的文本
  say(`${label}｜renderText === 去标签反转义(html)`, detachHtml(layout.html) === layout.renderText);

  // 7) 段落升序、不重叠、且首尾都能被 fullToRender 对上
  let ordered = true;
  let mapped = true;
  let lengthRelation = true;
  for (let i = 0; i < layout.paragraphs.length; i += 1) {
    const para = layout.paragraphs[i];
    if (!(para.fullEnd > para.fullStart) || !(para.renderEnd > para.renderStart)) ordered = false;
    if (i > 0 && layout.paragraphs[i - 1].fullEnd > para.fullStart) ordered = false;
    if (i > 0 && layout.paragraphs[i - 1].renderEnd > para.renderStart) ordered = false;
    if (fullToRender(layout, para.fullStart) !== para.renderStart) mapped = false;
    if (fullToRender(layout, para.fullEnd) !== para.renderEnd) mapped = false;
    const inside = removedInRange(removed, para.fullStart, para.fullEnd);
    if (para.renderEnd - para.renderStart !== para.fullEnd - para.fullStart - inside) lengthRelation = false;
  }
  say(`${label}｜段落升序不重叠`, ordered, `n=${layout.paragraphs.length}`);
  say(`${label}｜段落边界 fullToRender 对齐`, mapped);
  say(`${label}｜段长关系 renderLen === fullLen - 段内被删数`, lengthRelation);

  // 8) 段落区间与 renderText / html 段一一对应
  let sliceOk = true;
  for (const para of layout.paragraphs) {
    const slice = layout.renderText.slice(para.renderStart, para.renderEnd);
    if (slice.length !== para.renderEnd - para.renderStart || slice.length === 0) sliceOk = false;
  }
  say(`${label}｜每段 renderText 切片非空且长度自洽`, sliceOk);

  // 9) DOM 级对拍
  if (dom) {
    const { text: domText, paragraphs } = domTextOf(layout.html);
    say(`${label}｜DOM 文本节点拼接 === renderText`, domText === layout.renderText, `domLen=${domText.length} renderLen=${layout.renderText.length}`);
    let domParaOk = paragraphs.length === layout.paragraphs.length;
    if (domParaOk) {
      for (let i = 0; i < paragraphs.length; i += 1) {
        const para = layout.paragraphs[i];
        if (paragraphs[i].textContent !== layout.renderText.slice(para.renderStart, para.renderEnd)) domParaOk = false;
      }
    }
    say(`${label}｜DOM 每个 <p> 内容 === renderText 对应切片`, domParaOk);
  }

  // 10) 偏移往返
  if (exhaustiveRoundTrip) {
    let fwdOk = true; // renderToFull(fullToRender(x)) === x（x 未被删）
    const removedSet = new Set(removed);
    for (let x = 0; x <= text.length; x += 1) {
      if (removedSet.has(x)) continue;
      if (renderToFull(layout, fullToRender(layout, x)) !== x) {
        fwdOk = false;
        break;
      }
    }
    let bwdOk = true; // fullToRender(renderToFull(r)) === r
    for (let r = 0; r <= layout.renderText.length; r += 1) {
      if (fullToRender(layout, renderToFull(layout, r)) !== r) {
        bwdOk = false;
        break;
      }
    }
    say(`${label}｜往返 renderToFull(fullToRender(x)) === x`, fwdOk, `遍历 ${text.length} 个偏移`);
    say(`${label}｜往返 fullToRender(renderToFull(r)) === r`, bwdOk, `遍历 ${layout.renderText.length} 个偏移`);
  }

  return layout;
}

// ────────────────────────── 1) 对白专项（Lead 裁定 (a) 版） ──────────────────────────

console.log('\n━━━ 1) 对白专项（2026-10-19 Lead 裁定 (a)） ━━━');
{
  const a = layoutTxt('「我等你。」\n「好。」\n', 'auto');
  check(
    '对白①「我等你。」/「好。」→ 2 段',
    a.paragraphs.length === 2,
    `实际 ${a.paragraphs.length} 段  ${JSON.stringify(a.renderText)}`,
  );

  const b = layoutTxt('「你这个人真是，」\n他冷笑一声。\n', 'auto');
  check(
    '对白②「你这个人真是，」/他冷笑一声。→ 1 段（右引号不误断）',
    b.paragraphs.length === 1,
    `实际 ${b.paragraphs.length} 段  ${JSON.stringify(b.renderText)}`,
  );

  const c = layoutTxt('「你这个人真是，」\n「不知好歹。」\n', 'auto');
  check(
    '对白③「你这个人真是，」/「不知好歹。」→ 2 段（开引号规则优先）',
    c.paragraphs.length === 2,
    `实际 ${c.paragraphs.length} 段  ${JSON.stringify(c.renderText)}`,
  );

  // 修订判据的反面：右引号前是逗号、且下一行不是引号开头 → 必须合并
  const d = layoutTxt('他说：「你这个人真是，」\n然后转身走了。\n', 'auto');
  check('对白④「，」后接非引号叙述 → 1 段', d.paragraphs.length === 1, `实际 ${d.paragraphs.length} 段`);
}

// ────────────────────────── 2) 合成形态样本 ──────────────────────────

console.log('\n━━━ 2) 合成形态样本（判据误伤对抗） ━━━');

/** 造折行型样本：每行 35 字、段首全角缩进、行尾多为逗号。 */
function hardWrapSample() {
  const body = '他和她并肩走过长长的走廊，谁也没有先开口说话，只有窗外的雨声落在瓦上';
  const lines = [];
  for (let p = 0; p < 3; p += 1) {
    for (let i = 0; i < 4; i += 1) {
      const chunk = body.slice(i * 12, i * 12 + 12);
      lines.push(`${i === 0 ? '\u3000\u3000' : ''}${chunk}，`);
    }
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/，$/, '。')}`;
  }
  return `${lines.join('\n')}\n`;
}

{
  const hard = hardWrapSample();
  const layoutHard = invariants('折行型', hard, 'auto', { exhaustiveRoundTrip: true });
  const expectedLines = hard.split('\n').filter((l) => l.trim() !== '').length;
  check(
    '折行型｜3 段（每段 4 行合并）',
    layoutHard.paragraphs.length === 3,
    `实际 ${layoutHard.paragraphs.length} 段 / 非空行 ${expectedLines}`,
  );
  check('折行型｜合并数 = 9', layoutHard.stats.removedBreaks === 9, `实际 ${layoutHard.stats.removedBreaks}`);
  check('折行型｜shape = hard-wrap', layoutHard.stats.shape === 'hard-wrap', layoutHard.stats.shape);

  // 短段型：每行以 。 结尾、行长恒定 34 —— **最重要的一条：零合并**
  const shortLine = `${'文'.repeat(33)}。`; // 34 码元，句末标点收尾
  const shortLines = [];
  for (let i = 0; i < 40; i += 1) shortLines.push(shortLine);
  const shortText = `${shortLines.join('\n')}\n`;
  const layoutShort = invariants('短段型', shortText, 'auto', { exhaustiveRoundTrip: true });
  check(
    '短段型｜零合并（防误伤，最重要）',
    layoutShort.stats.removedBreaks === 0,
    `实际合并 ${layoutShort.stats.removedBreaks}`,
  );
  check(
    '短段型｜段数 === 非空行数',
    layoutShort.paragraphs.length === 40,
    `${layoutShort.paragraphs.length} vs 40`,
  );
  check('短段型｜shape = paragraph', layoutShort.stats.shape === 'paragraph', layoutShort.stats.shape);

  // 空行分段型
  const blankSep = '第一段到此结束。\n\n第二段另起一行。\n\n第三段也。\n';
  const layoutBlank = invariants('空行分段', blankSep, 'auto', { exhaustiveRoundTrip: true });
  check('空行分段｜3 段', layoutBlank.paragraphs.length === 3, `实际 ${layoutBlank.paragraphs.length}`);

  // 行尾拖尾空格 + 下一行缩进（模拟 圣女修道院 的 4 半角空格形态）
  const trailing = '上一段话说完了吧。   \n    新的一段从这里开始。\n';
  const layoutTrail = invariants('拖尾空格+缩进', trailing, 'auto', { exhaustiveRoundTrip: true });
  check('拖尾空格+缩进｜2 段', layoutTrail.paragraphs.length === 2, `实际 ${layoutTrail.paragraphs.length}`);
  check(
    '拖尾空格+缩进｜段边界处行尾空白保留（不进 removedPositions）',
    !layoutTrail.removedPositions.includes(9) &&
      !layoutTrail.removedPositions.includes(10) &&
      !layoutTrail.removedPositions.includes(11) &&
      layoutTrail.removedPositions.includes(12),
    `被删位置 ${JSON.stringify(layoutTrail.removedPositions)}（9/10/11 是行尾空格，12 是换行）`,
  );
  check('拖尾空格+缩进｜段首缩进被剥掉', layoutTrail.renderText.includes('    新的一段') === false);

  // 无换行型：单行 10 万字 → 兜底切段
  const giant = `${'这是一句没有任何标点的长文本'.repeat(1)}${'句子结束。'.repeat(4)}`.repeat(1);
  const noBreak = `前缀。${giant.repeat(2000)}`;
  const layoutNoBreak = invariants('无换行型', noBreak, 'auto', { dom: true });
  let maxPara = 0;
  for (const para of layoutNoBreak.paragraphs) {
    maxPara = Math.max(maxPara, para.renderEnd - para.renderStart);
  }
  check('无换行型｜每段 ≤ 800 字', maxPara <= 800, `最长段 ${maxPara} 字（原文 ${noBreak.length} 字）`);
  check('无换行型｜无 10 万字级巨段', maxPara < 100000, `最长段 ${maxPara}`);
  check('无换行型｜shape = no-break', layoutNoBreak.stats.shape === 'no-break', layoutNoBreak.stats.shape);

  // preserve 模式
  const preserveText = '\u3000\u3000第一行有缩进。\n第二行没有。\n\n第四行有内容。\n';
  const layoutPreserve = invariants('preserve', preserveText, 'preserve', { exhaustiveRoundTrip: true });
  check('preserve｜removedBreaks = 0', layoutPreserve.stats.removedBreaks === 0, `${layoutPreserve.stats.removedBreaks}`);
  check('preserve｜段数 = 非空行数 3', layoutPreserve.paragraphs.length === 3, `${layoutPreserve.paragraphs.length}`);
  check('preserve｜shape = preserve', layoutPreserve.stats.shape === 'preserve', layoutPreserve.stats.shape);
  check('preserve｜段首缩进仍被剥掉', !layoutPreserve.renderText.startsWith('\u3000'));
}

// ────────────────────────── 3) 换行符形态 ──────────────────────────

console.log('\n━━━ 3) 换行符形态（CRLF / 裸 CR / 混合） ━━━');
{
  const cases = [
    ['CRLF', '甲段结束。\r\n乙段开始。\r\n'],
    ['裸 CR', '甲段结束。\r乙段开始。\r'],
    ['CRLF 折行', '这句话没说完，\r\n接着往下说完了。\r\n'],
    ['混合 CRLF+LF', '甲。\r\n乙。\n丙。\r\n'],
    ['混合 CR+CRLF', '甲。\r乙。\r\n丙。\n'],
    ['行内混入 CR', '甲段。\r乙段。\n'],
  ];
  for (const [name, text] of cases) {
    const layout = invariants(`换行-${name}`, text, 'auto', { exhaustiveRoundTrip: true });
    check(`换行-${name}｜removedPositions 覆盖全部 \\r`, layout.renderText.indexOf('\r') === -1 && layout.renderText.indexOf('\n') === -1);
  }
}

// ────────────────────────── 4) 边界与恶意样本 ──────────────────────────

console.log('\n━━━ 4) 边界与恶意样本 ━━━');
{
  const samples = [
    ['空文本', ''],
    ['单空格', ' '],
    ['纯空白（含全角）', '   \u3000 \t '],
    ['只有一个换行', '\n'],
    ['只有 CRLF', '\r\n'],
    ['只有 3 个空行', '\n\n\n'],
    ['单个字符', '甲'],
    ['单个标点', '。'],
    ['无换行两字', '甲乙'],
    ['无换行整句', '这是一句完整的话。'],
    ['行尾标点+换行', '结束。\n'],
    ['行尾逗号+换行', '未完，\n'],
    ['全是空行与缩进', '\n   \n\u3000\n \t \n'],
    ['全角缩进一段', '\u3000\u3000正文一。\n'],
    ['4 空格缩进一段', '    正文二。\n'],
    ['1 空格缩进', ' 正文三。\n'],
    ['1 空格+引号开头', '前面没标点\n 「对白起头」\n'],
    ['tab 缩进', '\t正文四。\n'],
    ['行尾多空格', '正文五。      \n'],
    ['实体字符 &<>', 'AT&T <标签> 5>3 &amp; 结束。\n'],
    ['实体字符折行', 'AT&T <标签\n>&amp; 继续。\n'],
    ['emoji', '他笑了😀然后走了。\n她也笑了😀。\n'],
    ['扩展汉字 U+20000', '甲。\n𠀀𠀁。\n乙。\n'],
    ['代理对跨折行', '前半句𠀀，\n后半句𠀁完。\n'],
    ['组合字符', 'e\u0301\u0301组合。\n下一行。\n'],
    ['连续标点', '好！！！\n？？？\n……\n'],
    ['右括号收尾', '（他说完了）\n下一段。\n'],
    ['左引号在行中', '他说「你好」。\n「我很好」。\n'],
  ];
  for (const [name, text] of samples) {
    invariants(`边界-${name}`, text, 'auto', { exhaustiveRoundTrip: true });
  }
}

// ────────────────────────── 5) 代理对专项 ──────────────────────────

console.log('\n━━━ 5) 代理对（surrogate pair）专项 ━━━');
{
  const astral = '甲\n𠀀𠀁\n乙';
  check('代理对｜原文长度 8 码元（甲\\n+2 个双码元字+\\n乙）', astral.length === 8, `${astral.length}`);
  const layout = invariants('代理对', astral, 'auto', { exhaustiveRoundTrip: true });
  check('代理对｜renderText === 甲𠀀𠀁乙', layout.renderText === '甲𠀀𠀁乙', JSON.stringify(layout.renderText));
  check('代理对｜renderText 长度 6 码元', layout.renderText.length === 6, `${layout.renderText.length}`);
  check('代理对｜removedPositions === [1,6]', JSON.stringify(layout.removedPositions) === '[1,6]', JSON.stringify(layout.removedPositions));
  check('代理对｜fullToRender(2) === 1（高代理项起点）', fullToRender(layout, 2) === 1, `${fullToRender(layout, 2)}`);
  check('代理对｜fullToRender(3) === 2（低代理项，位于保留区内）', fullToRender(layout, 3) === 2, `${fullToRender(layout, 3)}`);
  check('代理对｜renderToFull(1) === 2', renderToFull(layout, 1) === 2, `${renderToFull(layout, 1)}`);
  check('代理对｜renderToFull(2) === 3', renderToFull(layout, 2) === 3, `${renderToFull(layout, 2)}`);
  check('代理对｜renderText 内代理对完整（未被打断）', layout.renderText.charCodeAt(1) === 0xd840 && layout.renderText.charCodeAt(2) === 0xdc00, `0x${layout.renderText.charCodeAt(1).toString(16)},0x${layout.renderText.charCodeAt(2).toString(16)}`);

  // emoji（U+1F600）按码元数参与一切长度/偏移计算
  const emoji = '😀😀。\n下一行😀。';
  const layoutEmoji = invariants('emoji', emoji, 'auto', { exhaustiveRoundTrip: true });
  check('emoji｜原文长度 12 码元', emoji.length === 12, `${emoji.length}`);
  check('emoji｜renderText === 去换行结果', layoutEmoji.renderText === '😀😀。下一行😀。', JSON.stringify(layoutEmoji.renderText));

  // 兜底切段处的代理对：构造 800 的切点落在代理对中间
  // 索引 0 = '甲'（单码元），其后全为双码元的 '𠀀'；高代理项落在奇数下标 → 800 是低代理项
  const longAstral = `甲${'𠀀'.repeat(50000)}`;
  const layoutLong = layoutTxt(longAstral, 'auto');
  /** 统计「起点是低代理项」或「终点是高代理项」的段落数（即被劈开的代理对）。 */
  const countSplitParas = (layout) => {
    let count = 0;
    for (const para of layout.paragraphs) {
      const slice = layout.renderText.slice(para.renderStart, para.renderEnd);
      const first = slice.charCodeAt(0);
      const last = slice.charCodeAt(slice.length - 1);
      if ((first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff)) count += 1;
    }
    return count;
  };
  const splitCount = countSplitParas(layoutLong);
  check(
    '代理对｜兜底切段不劈开代理对（10 万码元单行）',
    splitCount === 0,
    splitCount === 0 ? `未劈开，共 ${layoutLong.paragraphs.length} 段` : `有 ${splitCount} 段起止落在代理对中间（共 ${layoutLong.paragraphs.length} 段）`,
  );
  check('代理对｜兜底切段 renderText 仍等于原文去掉被删字符', layoutLong.renderText === longAstral.replace(/\n/g, ''), `renderLen=${layoutLong.renderText.length}`);

  // 最小复现：803 码元即可触发（切点落在第 400 个 '𠀀' 中间）
  const minimalAstral = `甲${'𠀀'.repeat(401)}`;
  const layoutMinimal = layoutTxt(minimalAstral, 'auto');
  const minimalSplit = countSplitParas(layoutMinimal);
  check(
    '代理对｜最小复现 803 码元触发劈开',
    minimalSplit === 0,
    `原文 ${minimalAstral.length} 码元 → ${layoutMinimal.paragraphs.length} 段，被劈开 ${minimalSplit} 段`,
  );
  // 修复后应有的段长（verifier 独立复核 layout-engine 报的 [799, 4]）
  const minimalLens = layoutMinimal.paragraphs.map((para) => para.renderEnd - para.renderStart);
  check(
    '代理对｜修复后段长 [799, 4] 且 ≤ 800（独立复核修复方案）',
    JSON.stringify(minimalLens) === '[799,4]',
    `实际段长 ${JSON.stringify(minimalLens)}`,
  );
  check(
    '代理对｜修复后切点前后无缝（前段 fullEnd === 后段 fullStart）',
    layoutMinimal.paragraphs.length === 2 &&
      layoutMinimal.paragraphs[0].fullEnd === layoutMinimal.paragraphs[1].fullStart,
    layoutMinimal.paragraphs.map((p) => `[${p.fullStart},${p.fullEnd})`).join(' '),
  );

  // 对抗：**畸形输入** —— 孤立高代理项正好落在 800 切点上（源文件本身就有坏码元）
  const malformed = `甲${'𠀀'.repeat(399)}\uD83D${'x'.repeat(500)}`;
  const layoutMalformed = invariants('孤立代理项', malformed, 'auto', { exhaustiveRoundTrip: false });
  let malformedOk = true;
  for (const para of layoutMalformed.paragraphs) {
    if (para.renderEnd - para.renderStart > 800) malformedOk = false;
  }
  check(
    '代理对｜畸形输入（孤立高代理项在切点）不崩且段长仍 ≤ 800',
    malformedOk,
    `段数 ${layoutMalformed.paragraphs.length}，段长 ${JSON.stringify(layoutMalformed.paragraphs.map((p) => p.renderEnd - p.renderStart).slice(0, 4))}…`,
  );

  // 后果评估：孤立代理项经 HTML 解析后会不会被替换成 U+FFFD（若会，用户看到的是乱码方块）
  const domMinimal = domTextOf(layoutMinimal.html).text;
  const fffd = (domMinimal.match(/\uFFFD/g) || []).length;
  check(
    '代理对｜DOM 解析后不产生 U+FFFD',
    fffd === 0,
    `U+FFFD ${fffd} 个；DOM 文本长度 ${domMinimal.length}，renderText 长度 ${layoutMinimal.renderText.length}`,
  );
  check('代理对｜DOM 文本仍 === renderText', domMinimal === layoutMinimal.renderText);
}

// ────────────────────────── 6) 划线端到端对拍 ──────────────────────────

console.log('\n━━━ 6) 划线端到端对拍（渲染选区 ↔ 原文区间） ━━━');
{
  const strip = (s) => s.replace(/\s+/g, '');
  const sample = '「第一段对白，还没说完，」\n「那就接着说完它。」\n他转身走了。\r\n第三段在这里。\n';
  const layout = layoutTxt(sample, 'auto');

  // 渲染 → 原文：在渲染文本上选 [a,b)，换回原文后内容应一致（忽略被删空白）
  let contentOk = true;
  let roundTripOk = true;
  const renderLen = layout.renderText.length;
  for (let a = 0; a < renderLen; a += 1) {
    for (let b = a + 1; b <= renderLen; b += 1) {
      const from = renderToFull(layout, a);
      const to = renderToFull(layout, b);
      if (strip(sample.slice(from, to)) !== strip(layout.renderText.slice(a, b))) contentOk = false;
      if (fullToRender(layout, from) !== a || fullToRender(layout, to) !== b) roundTripOk = false;
    }
  }
  check('划线｜渲染选区 → 原文区间 内容一致（忽略空白）', contentOk, `遍历 ${(renderLen * (renderLen + 1)) / 2} 个区间`);
  check('划线｜渲染选区 → 原文 → 渲染 严格往返', roundTripOk, `遍历 ${(renderLen * (renderLen + 1)) / 2} 个区间`);

  // 原文 → 渲染：给定原文区间，切渲染文本内容一致
  let backOk = true;
  for (let from = 0; from <= sample.length; from += 1) {
    for (let to = from + 1; to <= sample.length; to += 1) {
      const a = fullToRender(layout, from);
      const b = fullToRender(layout, to);
      if (strip(sample.slice(from, to)) !== strip(layout.renderText.slice(a, b))) backOk = false;
    }
  }
  check('划线｜原文区间 → 渲染区间 内容一致（忽略空白）', backOk, `遍历 ${(sample.length * (sample.length + 1)) / 2} 个区间`);

  // DOM 取出的文本上做同样的事（真实链路：DOM 才是选区的真相）
  const { text: domText } = domTextOf(layout.html);
  check('划线｜DOM 文本与 renderText 一致（选区基数正确）', domText === layout.renderText);

  // 模拟真实选区：在 DOM 上选 [a,b) → 与在 renderText 上选一致
  const a = 2;
  const b = 12;
  const from = renderToFull(layout, a);
  const to = renderToFull(layout, b);
  check(
    '划线｜示例选区 [2,12) 映射内容一致',
    strip(domText.slice(a, b)) === strip(sample.slice(from, to)),
    `原文 [${from},${to})  "${sample.slice(from, to).replace(/\r?\n/g, '⏎')}"`,
  );
}

// ────────────────────────── 7) escapeHtmlText ──────────────────────────

console.log('\n━━━ 7) escapeHtmlText ━━━');
{
  check('escape｜& → &amp;', escapeHtmlText('a&b') === 'a&amp;b', escapeHtmlText('a&b'));
  check('escape｜< → &lt;', escapeHtmlText('a<b') === 'a&lt;b');
  check('escape｜> → &gt;', escapeHtmlText('a>b') === 'a&gt;b');
  check('escape｜& 只转一次', escapeHtmlText('&amp;') === '&amp;amp;', escapeHtmlText('&amp;'));
  check('escape｜不转义引号', escapeHtmlText('"\'') === '"\'');
  check('escape｜空串', escapeHtmlText('') === '');
  check('escape｜无特殊字符原样返回', escapeHtmlText('普通中文。') === '普通中文。');
  check('escape｜反转义往返', detachHtml(`<p>${escapeHtmlText('a&b<c>d')}</p>`) === 'a&b<c>d');
}

// ────────────────────────── 8) 性能 ──────────────────────────

console.log('\n━━━ 8) 性能 ━━━');
{
  const unitText = '他和她并肩走过长长的走廊，谁也没有先开口说话，只有窗外的雨声落在瓦上，';
  const unit36k = unitText.repeat(Math.ceil(36000 / unitText.length)).slice(0, 36000);
  /** 取 N 次均值。 */
  const bench = (fn, rounds) => {
    fn(); // 预热
    const t0 = performance.now();
    for (let i = 0; i < rounds; i += 1) fn();
    return (performance.now() - t0) / rounds;
  };
  const autoMs = bench(() => layoutTxt(unit36k, 'auto'), 30);
  const preserveMs = bench(() => layoutTxt(unit36k, 'preserve'), 30);
  check('性能｜3.6 万字 auto 单次 < 30ms', autoMs < 30, `均值 ${autoMs.toFixed(2)}ms（${unit36k.length} 码元）`);
  check('性能｜3.6 万字 preserve 单次 < 30ms', preserveMs < 30, `均值 ${preserveMs.toFixed(2)}ms`);

  // 最坏情形：3.6 万码元单行、无任何换行
  const worst = `甲${'𠀀'.repeat(18000)}`;
  const worstMs = bench(() => layoutTxt(worst, 'auto'), 20);
  check('性能｜3.6 万码元无换行单行 < 30ms', worstMs < 30, `均值 ${worstMs.toFixed(2)}ms`);

  // 纯 ASCII 长文档（避免中文常量池影响）
  const ascii = `${'lorem ipsum dolor sit amet. '.repeat(1400)}`;
  const asciiMs = bench(() => layoutTxt(ascii, 'auto'), 30);
  check('性能｜3.6 万字符英文 < 30ms', asciiMs < 30, `均值 ${asciiMs.toFixed(2)}ms（${ascii.length}）`);
}

// ────────────────────────── 9) 真实书回放 ──────────────────────────

console.log('\n━━━ 9) 真实书回放（只读，不落正文） ━━━');

const BOOK_DIR = 'C:\\Users\\lihua\\OneDrive\\图书\\';
/** 每本书的期望形态与验收阈值。 */
const BOOK_CASES = [
  { file: '借种.txt', kind: '折行型', minFold: 0.8, maxFold: 1.01, shape: 'hard-wrap' },
  { file: '女片儿警也是女人.txt', kind: '折行型', minFold: 0.8, maxFold: 1.01, shape: 'hard-wrap' },
  { file: '准夫妻的性生活1-33.txt', kind: '折行型(混合)', minFold: 0.8, maxFold: 1.01, shape: 'hard-wrap' },
  { file: '我和我的妹妹雯雯.txt', kind: '短段型', minFold: -0.01, maxFold: 0.05, shape: 'paragraph' },
  { file: '圣女修道院.txt', kind: '短段型', minFold: -0.01, maxFold: 0.05, shape: 'paragraph' },
  { file: '蓝天航空公司的空姐.txt', kind: '无换行型', minFold: -0.01, maxFold: 1.01, shape: 'no-break' },
];

if (process.argv.includes('--no-books') || !existsSync(BOOK_DIR)) {
  console.log(`跳过真实书回放（${existsSync(BOOK_DIR) ? '--no-books' : '书库目录不存在'}）`);
} else {
  const rows = [];
  for (const bookCase of BOOK_CASES) {
    const raw = readFileSync(BOOK_DIR + bookCase.file);
    const t0 = performance.now();
    const decoded = decodeTextBytes(new Uint8Array(raw));
    const units = splitTextUnits(decoded.text, DEFAULT_UNIT_CHARS);
    let merges = 0;
    let predictedMerges = 0;
    let decisionPairs = 0;
    let sentences = 0;
    let quotes = 0;
    let maxPara = 0;
    let longestPara = 0;
    const shapes = new Set();
    let invariantBad = 0;
    let domChecked = 0;
    let oraclePairs = 0;
    let oracleDiverged = 0;
    let oracleUnits = 0;
    let crTotal = 0;
    let crMissed = 0;
    let newBreaks = 0;
    let newBreakQuote = 0;
    let newBreakPunct = 0;
    let newBreakPunctSoft = 0;
    let newBreakAtWrap = 0;

    // 本书折行列宽（众数行长），用于分类「新增断点是否落在折行列宽上」
    const bookLines = decoded.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const histogram = new Map();
    for (const line of bookLines) {
      if (line.trim() === '') continue;
      histogram.set(line.length, (histogram.get(line.length) || 0) + 1);
    }
    let modalLen = 0;
    let modalCount = 0;
    for (const [len, count] of histogram) {
      if (count > modalCount) {
        modalLen = len;
        modalCount = count;
      }
    }

    for (const unit of units) {
      const layout = layoutTxt(unit.text, 'auto');
      const decision = independentDecision(unit.text);
      merges += layout.stats.removedBreaks;
      predictedMerges += decision.merges;
      decisionPairs += decision.decisionPairs;
      sentences += decision.sentBreaks;
      quotes += decision.quoteBreaks;
      shapes.add(layout.stats.shape);
      for (const para of layout.paragraphs) {
        const len = para.renderEnd - para.renderStart;
        if (len > longestPara) longestPara = len;
      }
      maxPara = Math.max(maxPara, longestPara);

      // `\r` 记账：单元里每一个 `\r` 都必须出现在 removedPositions 里（漏一个就每行错 1 位）
      const removedSet = new Set(layout.removedPositions);
      for (let p = 0; p < unit.text.length; p += 1) {
        if (unit.text.charCodeAt(p) === 13) {
          crTotal += 1;
          if (!removedSet.has(p)) crMissed += 1;
        }
      }

      // 新增断点分类（裁定后判为断、契约字面版判为合并的点）
      for (let i = 0; i < decision.lines.length - 1; i += 1) {
        const verdict = decision.verdicts[i];
        if (verdict !== 'sent' && verdict !== 'quote') continue;
        const line = decision.lines[i];
        const next = decision.lines[i + 1];
        const lineText = unit.text.slice(line.start, line.end).replace(/\r/g, '');
        const nextText = unit.text.slice(next.start, next.end).replace(/\r/g, '');
        if (contractVerdict(lineText, nextText) !== 'merge') continue;
        newBreaks += 1;
        const rtrimLen = rtrim(lineText).length;
        if (Math.abs(rtrimLen - modalLen) <= 3) newBreakAtWrap += 1;
        const first = nextText[0];
        if (first !== undefined && LEADING_QUOTES.has(first)) newBreakQuote += 1;
        if (first !== undefined && LEADING_PUNCT_HARD.has(first)) newBreakPunct += 1;
        if (first !== undefined && LEADING_PUNCT_SOFT.has(first)) newBreakPunctSoft += 1;
      }

      // 每条不变量都验（quiet 模式，避免刷屏），并抽查 DOM
      const before = failed;
      invariants(`${bookCase.file}#${unit.index}`, unit.text, 'auto', { dom: domChecked < 12, quiet: true });
      if (failed > before) invariantBad += 1;
      if (domChecked < 12) domChecked += 1;

      // 逐对还原实现的决策（前 2 个单元，避免 O(n²) 过久），排除聚合数互相抵消
      if (oracleUnits < 2 && decision.lines.length <= 1500) {
        const oracle = perPairOracle(unit.text, decision.verdicts);
        oraclePairs += oracle.pairs;
        oracleDiverged += oracle.diverged;
        oracleUnits += 1;
        if (oracle.first !== null) {
          console.log(
            `      ↳ ${bookCase.file} 单元#${unit.index} 首个分歧：行 ${oracle.first.line} 实现=${oracle.first.impl} 复算=${oracle.first.mine}`,
          );
        }
      }

      // 段长上限断言（仅无换行型书）
      if (bookCase.shape === 'no-break') {
        for (const para of layout.paragraphs) {
          if (para.renderEnd - para.renderStart > 800) invariantBad += 1;
        }
      }
    }
    const elapsed = performance.now() - t0;
    const foldRate = decisionPairs === 0 ? 0 : merges / decisionPairs;
    rows.push({
      file: bookCase.file,
      kind: bookCase.kind,
      chars: decoded.text.length,
      units: units.length,
      merges,
      predictedMerges,
      decisionPairs,
      sentences,
      quotes,
      foldRate,
      longestPara,
      shapes: [...shapes].join('/'),
      invariantBad,
      ms: elapsed,
      crTotal,
      crMissed,
      newBreaks,
      newBreakQuote,
      newBreakPunct,
      newBreakPunctSoft,
      newBreakAtWrap,
    });

    check(
      `${bookCase.file}｜不变量全部成立（含 DOM 对拍 ${domChecked}/${units.length} 个单元）`,
      invariantBad === 0,
      `违规单元 ${invariantBad}`,
    );
    check(
      `${bookCase.file}｜实际合并数 === 独立复算预测数`,
      merges === predictedMerges,
      `实际 ${merges} / 预测 ${predictedMerges}`,
    );
    check(
      `${bookCase.file}｜逐对还原决策零分歧（${oracleUnits} 个单元 / ${oraclePairs} 个行对）`,
      oracleDiverged === 0,
      `分歧 ${oracleDiverged} 处`,
    );
    check(
      `${bookCase.file}｜每个 \\r 都记入 removedPositions（共 ${crTotal} 个）`,
      crMissed === 0,
      `漏记 ${crMissed} 个`,
    );
    check(
      `${bookCase.file}｜新增断点无「硬标点起段」（段落不可能以 ，。、；：！？」』）】》 开头）`,
      newBreakPunct === 0,
      `新增断点 ${newBreaks}（≈列宽 ${newBreakAtWrap}），硬标点起段 ${newBreakPunct}，` +
        `省略号类起段 ${newBreakPunctSoft}，左引号起段 ${newBreakQuote}（${((newBreakQuote / Math.max(1, newBreaks)) * 100).toFixed(1)}%）`,
    );
    check(
      `${bookCase.file}｜折行率 ∈ [${(bookCase.minFold * 100).toFixed(0)}%, ${(bookCase.maxFold * 100).toFixed(0)}%]`,
      foldRate >= bookCase.minFold && foldRate <= bookCase.maxFold,
      `实际 ${(foldRate * 100).toFixed(1)}%（合并 ${merges} / 判定对 ${decisionPairs}）`,
    );
    if (bookCase.shape === 'no-break') {
      check(
        `${bookCase.file}｜兜底切段后无巨段（最长段 ≤ 800）`,
        longestPara <= 800,
        `最长段 ${longestPara} 字`,
      );
    }
    if (bookCase.file === '我和我的妹妹雯雯.txt') {
      check(
        '我和我的妹妹雯雯.txt｜合并数从 89 降到 ≈8（Lead 指定验收指标）',
        merges >= 1 && merges <= 15,
        `实际 ${merges}（修复前独立复算 89）`,
      );
    }
    if (bookCase.file === '蓝天航空公司的空姐.txt') {
      check(
        '蓝天航空公司的空姐.txt｜无 10 万字级巨段',
        longestPara < 100000,
        `最长段 ${longestPara} 字（原文最长行 101546 字）`,
      );
    }
  }

  const header =
    '书名'.padEnd(30) +
    '形态'.padStart(14) +
    '字数'.padStart(9) +
    '单元'.padStart(6) +
    '合并'.padStart(7) +
    '预测'.padStart(7) +
    '判定对'.padStart(8) +
    '折行率'.padStart(9) +
    '最长段'.padStart(8) +
    'shape'.padStart(10) +
    '耗时ms'.padStart(9);
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length + 6));
  for (const row of rows) {
    console.log(
      row.file.padEnd(30) +
        row.kind.padStart(14) +
        String(row.chars).padStart(9) +
        String(row.units).padStart(6) +
        String(row.merges).padStart(7) +
        String(row.predictedMerges).padStart(7) +
        String(row.decisionPairs).padStart(8) +
        `${(row.foldRate * 100).toFixed(1)}%`.padStart(9) +
        String(row.longestPara).padStart(8) +
        row.shapes.padStart(10) +
        row.ms.toFixed(0).padStart(9),
    );
  }

  // ── 新增断点（裁定 vs 契约字面版）的分布 ──
  const nbHeader =
    '书名'.padEnd(30) + '新增断点'.padStart(10) + '≈列宽'.padStart(8) + '下段左引号'.padStart(11) + '硬标点起段'.padStart(12) + '省略号起段'.padStart(11) + '\\r 总数'.padStart(9) + '漏记'.padStart(6);
  console.log('');
  console.log('新增段边界的反向风险（相对**最初契约**的净新增段边界 = 右引号条件规则 + 开引号规则）：');
  console.log(nbHeader);
  console.log('-'.repeat(nbHeader.length));
  for (const row of rows) {
    console.log(
      row.file.padEnd(30) +
        String(row.newBreaks).padStart(10) +
        String(row.newBreakAtWrap).padStart(8) +
        String(row.newBreakQuote).padStart(11) +
        String(row.newBreakPunct).padStart(12) +
        String(row.newBreakPunctSoft).padStart(11) +
        String(row.crTotal).padStart(9) +
        String(row.crMissed).padStart(6),
    );
  }

  // ── 与「预注册基准」逐项对拍 ──
  /** 落地前独立复算的预测值（`docs/diag-txt-linebreak/independent-prediction-fixed.mjs` 与 task-3 表）。 */
  const PRE_REGISTERED = new Map([
    ['我和我的妹妹雯雯.txt', 7],
    ['借种.txt', 1293],
    ['女片儿警也是女人.txt', 4178],
    ['准夫妻的性生活1-33.txt', 1932],
    ['圣女修道院.txt', 0],
    ['蓝天航空公司的空姐.txt', 1699],
  ]);
  const prHeader = '书名'.padEnd(30) + '预注册'.padStart(9) + '实际'.padStart(8) + '差'.padStart(6);
  console.log('');
  console.log('与落地前「预注册基准」的逐项对拍：');
  console.log(prHeader);
  console.log('-'.repeat(prHeader.length));
  let preRegOk = true;
  for (const row of rows) {
    const predicted = PRE_REGISTERED.get(row.file) ?? 0;
    const diff = row.merges - predicted;
    const tolerance = Math.max(3, predicted * 0.01);
    if (Math.abs(diff) > tolerance) preRegOk = false;
    console.log(
      row.file.padEnd(30) +
        String(predicted).padStart(9) +
        String(row.merges).padStart(8) +
        `${diff >= 0 ? '+' : ''}${diff}`.padStart(6),
    );
  }
  check(
    '预注册基准逐项对拍（容差 max(3, 1%)）',
    preRegOk,
    '差异来源已由 independent-attribution-prereg.mjs 精确归因到三条近似（原始首字符 / 裁定后标点集合 / 逐单元）',
  );
}

// ────────────────────────── 汇总 ──────────────────────────

console.log(`\n共 ${total} 条断言，失败 ${failed} 条`);
if (failed > 0) {
  console.log('失败清单：');
  for (const name of failures.slice(0, 40)) console.log(`  - ${name}`);
}
console.log(failed === 0 ? 'TXT 重排独立验收：全部通过' : 'TXT 重排独立验收：存在失败项');
process.exit(failed === 0 ? 0 : 1);
