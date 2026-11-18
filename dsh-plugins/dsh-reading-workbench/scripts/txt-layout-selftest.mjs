/**
 * txt-layout 自测（纯函数，不依赖 DOM / DSH）。
 *
 * 覆盖：段边界判据（含右引号条件判据与「下一行以引号开头」）、形态统计、兜底切段、
 * preserve 语义、CRLF/裸 \r、偏移双向映射往返、`renderText === 反转义(去标签(html))` 不变量、
 * 以及 O(n) 性能。
 *
 * 全部样本都是本脚本**合成**的短文本（真实藏书正文严禁写进仓库）。
 *
 * 直接加载 TS 源码：本机 node 24 自带类型擦除（type stripping）。
 * 用法：node scripts/txt-layout-selftest.mjs
 */
import { escapeHtmlText, fullToRender, layoutTxt, renderToFull } from '../src/client/txt-layout.ts';

let allPass = true;
let total = 0;
/** 断言打印（与 paginate-selftest.mjs 同风格）。 */
function check(name, condition, detail) {
  total += 1;
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

// ── 工具 ────────────────────────────────────────────────
/** html 去标签（只剩 `<p>` / `</p>` 两种标签）。 */
function stripTags(html) {
  return html.replace(/<\/?p>/g, '');
}
/** 反转义（顺序要对：先 &lt;/&gt; 再 &amp;，否则 `&amp;lt;` 会被多解一次）。 */
function unescapeHtml(source) {
  return source.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
/** html 去标签并反转义 —— 契约第 6 条要求它等于 renderText。 */
function textOfHtml(html) {
  return unescapeHtml(stripTags(html));
}
/** 统计 html 里的段落数。 */
function paragraphTagsOf(html) {
  return (html.match(/<p>/g) ?? []).length;
}
/** 升序数组是否严格升序且无重复。 */
function isStrictlyAscending(values) {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= values[i - 1]) return false;
  }
  return true;
}

// ── 合成样本 ────────────────────────────────────────────

/** 35 字的折行行体（行尾再补标点）。 */
const WRAP_LINE = '山里的雾气还没散他背起柴刀往坡上走脚下的碎石子硌得生疼却也没敢停下脚步';

/** 折行型：段首全角缩进 + 行长 35 + 行尾多为逗号 → 应合并成整段。 */
const wrappedText = [
  `　　${WRAP_LINE}，`,
  `${WRAP_LINE}，`,
  '他终于在日头爬到头顶的时候歇了口气。',
  `　　${WRAP_LINE}，`,
  '他蹲在溪边捧起一捧凉水喝了。',
].join('\n');

/** 短段型：行长恒定 34 字、行尾一律 `。` → 必须零合并（防误伤，最重要的一条）。 */
const SHORT_CORE = '他放下碗筷抬头看了看窗外的天色继续吃面';
function shortParagraphLine(index) {
  const head = `第${index + 1}句`;
  const tail = '。';
  const filler = '也'.repeat(Math.max(0, 34 - head.length - SHORT_CORE.length - tail.length));
  return head + SHORT_CORE + filler + tail;
}
const shortLines = Array.from({ length: 6 }, (_, i) => shortParagraphLine(i));
const shortText = shortLines.join('\n');

/** 空行分段型。 */
const blankText = 'a\n\nb\n\nc';

/** 拖尾空格 + 下一行 4 半角空格缩进（模拟 `圣女修道院.txt` 形态）。 */
const trailingText = '前半句还没说完，   \n    新段落从这里开始，也没说完，\n    这里才收尾。';

/** 单行近 10 万字：整篇没有换行，靠兜底切段。 */
const HUGE_SENTENCE = '他说完这句话就再也没有回头。'; // 14 字
const hugeText = HUGE_SENTENCE.repeat(7000); // 98000 字

/** 无换行但不算超长行的样本（触发 no-break 的第二条判据：字符数/非空行数 > 2000）。 */
const denseOneLine = HUGE_SENTENCE.repeat(300); // 4200 字、1 行

/** 性能样本：约 3.7 万字、1000 行的折行型文本。 */
const perfLines = [];
for (let i = 0; i < 1000; i += 1) {
  perfLines.push(`${i % 5 === 0 ? '　　' : ''}${WRAP_LINE}${i % 3 === 0 ? '。' : '，'}`);
}
const perfText = perfLines.join('\n');

// ── 1) 空文本与全空行 ────────────────────────────────────
const empty = layoutTxt('');
check('空文本 html 为空串', empty.html === '', JSON.stringify(empty.html));
check('空文本 renderText 为空串', empty.renderText === '');
check('空文本无段落', empty.paragraphs.length === 0);
check('空文本无被删位置', empty.removedPositions.length === 0);
check('空文本 shape 为 paragraph', empty.stats.shape === 'paragraph', empty.stats.shape);
check('空文本 preserve 下 shape 为 preserve', layoutTxt('', 'preserve').stats.shape === 'preserve');

const blankOnly = layoutTxt('\n\n  \n');
check('全空行文本无段落', blankOnly.paragraphs.length === 0 && blankOnly.renderText === '');
// '\n\n  \n' 共 5 个字符，全部要被删掉（空行不属于任何段落）
check(
  '全空行的每个字符都被记账删除',
  blankOnly.removedPositions.length === 5 && isStrictlyAscending(blankOnly.removedPositions),
  `removed=${blankOnly.removedPositions.length}`,
);

// ── 2) 折行型：必须合并成整段 ────────────────────────────
const wrapped = layoutTxt(wrappedText);
const wrappedParas = wrapped.paragraphs;
check('折行型：切成 2 段', wrappedParas.length === 2, `→ ${wrappedParas.length}`);
check('折行型：合并 3 个折行', wrapped.stats.removedBreaks === 3, `→ ${wrapped.stats.removedBreaks}`);
check('折行型：非空行数 5', wrapped.stats.rawLines === 5, `→ ${wrapped.stats.rawLines}`);
check(
  '折行型：首段文本正确接回',
  wrapped.renderText.slice(wrappedParas[0].renderStart, wrappedParas[0].renderEnd) ===
    `${WRAP_LINE}，${WRAP_LINE}，他终于在日头爬到头顶的时候歇了口气。`,
);
check(
  '折行型：次段文本正确接回',
  wrapped.renderText.slice(wrappedParas[1].renderStart, wrappedParas[1].renderEnd) ===
    `${WRAP_LINE}，他蹲在溪边捧起一捧凉水喝了。`,
);
check('折行型：shape 为 hard-wrap', wrapped.stats.shape === 'hard-wrap', wrapped.stats.shape);
check('折行型：段首缩进被剥掉', wrapped.removedPositions.includes(0) && wrapped.removedPositions.includes(1));
check('折行型：renderText 不含换行', !/[\n\r]/.test(wrapped.renderText));
check('折行型：html 段数与段落数一致', paragraphTagsOf(wrapped.html) === 2);

// ── 3) 短段型：必须零合并（防误伤，最重要）──────────────
const short = layoutTxt(shortText);
check('短段型：每行独立成段（6 段）', short.paragraphs.length === 6, `→ ${short.paragraphs.length}`);
check('短段型：零合并', short.stats.removedBreaks === 0, `→ ${short.stats.removedBreaks}`);
check('短段型：shape 为 paragraph', short.stats.shape === 'paragraph', short.stats.shape);
check(
  '短段型：段文本逐行对应',
  short.paragraphs.every(
    (para, i) => short.renderText.slice(para.renderStart, para.renderEnd) === shortLines[i],
  ),
);
check(
  '短段型：行长恒为 34 字',
  shortLines.every((line) => line.length === 34),
  `实测 ${shortLines[0].length}`,
);
check('短段型：被删的只有 5 个换行', short.removedPositions.length === 5, `→ ${short.removedPositions.length}`);

// ── 4) 空行分段型 ────────────────────────────────────────
const blank = layoutTxt(blankText);
check('空行分段：切成 3 段', blank.paragraphs.length === 3, `→ ${blank.paragraphs.length}`);
check('空行分段：零合并', blank.stats.removedBreaks === 0);
check('空行分段：文本为 a/b/c', blank.renderText === 'abc', JSON.stringify(blank.renderText));
check('空行分段：空行的 4 个换行被删（其余字符也都不属于段落）', blank.removedPositions.length === 4);

// ── 5) 拖尾空格 + 下一行缩进 ─────────────────────────────
const trailing = layoutTxt(trailingText);
check('拖尾空格：切成 3 段', trailing.paragraphs.length === 3, `→ ${trailing.paragraphs.length}`);
check('拖尾空格：零合并', trailing.stats.removedBreaks === 0);
check(
  '拖尾空格：段边界的行尾空白保留',
  trailing.renderText.slice(trailing.paragraphs[0].renderStart, trailing.paragraphs[0].renderEnd) ===
    '前半句还没说完，   ',
  JSON.stringify(trailing.renderText.slice(0, trailing.paragraphs[0].renderEnd)),
);
check(
  '拖尾空格：4 个半角空格缩进被剥掉',
  trailing.renderText.slice(trailing.paragraphs[1].renderStart, trailing.paragraphs[1].renderEnd) ===
    '新段落从这里开始，也没说完，',
);
check(
  '拖尾空格：末段缩进同样剥掉',
  trailing.renderText.slice(trailing.paragraphs[2].renderStart, trailing.paragraphs[2].renderEnd) === '这里才收尾。',
);

// 只有 1 个半角空格不算缩进：空格保留、且不触发段边界
const singleSpace = layoutTxt('第一行没说完，\n 第二行。');
check('单个半角空格不算缩进（不误剥）', singleSpace.renderText === '第一行没说完， 第二行。', JSON.stringify(singleSpace.renderText));
check('单个半角空格不触发缩进判据（仍合并）', singleSpace.paragraphs.length === 1 && singleSpace.stats.removedBreaks === 1);

// ── 6) 对白行（修订版判据，verifier 实测缺口）────────────
const dialogueHard = layoutTxt('「我等你。」\n「好。」');
check('对白：`。」` 结尾 → 2 段（不粘连）', dialogueHard.paragraphs.length === 2, `→ ${dialogueHard.paragraphs.length}`);
check('对白：`。」` 结尾不产生折行合并', dialogueHard.stats.removedBreaks === 0);
check('对白：两段文本原样', dialogueHard.renderText === '「我等你。」「好。」', JSON.stringify(dialogueHard.renderText));

const dialogueSoft = layoutTxt('「你这个人真是，」\n他冷笑一声。');
check('对白：`，」` 结尾且下一行非引号 → 合并为 1 段', dialogueSoft.paragraphs.length === 1, `→ ${dialogueSoft.paragraphs.length}`);
check('对白：`，」` 结尾合并计数为 1', dialogueSoft.stats.removedBreaks === 1);
check('对白：`，」` 合并后文本正确', dialogueSoft.renderText === '「你这个人真是，」他冷笑一声。', JSON.stringify(dialogueSoft.renderText));

// 开引号规则**优先于**右引号条件判据：两行各以引号起/收，本来就是两个说话段。
// lead 裁决依据：新判据把 703 处换行由合并改断，其中 538 处（76.5%）下一行首字符是左引号；
// 砍掉开引号规则等于把那 538 处退回粘连（与本次要修的 `雯雯` 对白粘连同类）。
const dialogueTwoSpeakers = layoutTxt('「你这个人真是，」\n「不知好歹。」');
check(
  '对白：`，」` 结尾但下一行以 「 开头 → 2 段（开引号规则优先）',
  dialogueTwoSpeakers.paragraphs.length === 2,
  `→ ${dialogueTwoSpeakers.paragraphs.length}`,
);
check('对白：开引号规则优先时不产生折行合并', dialogueTwoSpeakers.stats.removedBreaks === 0);
check(
  '对白：开引号规则优先时两段文本原样',
  dialogueTwoSpeakers.renderText === '「你这个人真是，」「不知好歹。」',
  JSON.stringify(dialogueTwoSpeakers.renderText),
);

const dialogueThree = layoutTxt('「我不走。」\n「你必须走。」\n「那就这样。」');
check('对白：连续三行全部断开', dialogueThree.paragraphs.length === 3, `→ ${dialogueThree.paragraphs.length}`);

const leadingQuote = layoutTxt('前面的句子还没说完，\n“下一句从这里开始。”');
check(
  '对白：下一行以 “ 开头 → 段边界（独立判据生效）',
  leadingQuote.paragraphs.length === 2,
  `→ ${leadingQuote.paragraphs.length}`,
);

const leadingQuote2 = layoutTxt('他还想再说什么，\n『可话到嘴边又咽了回去。』');
check('对白：下一行以 『 开头 → 段边界', leadingQuote2.paragraphs.length === 2, `→ ${leadingQuote2.paragraphs.length}`);

// 右引号前面不是句末标点时，不应被误当成段尾标点
const noEndQuote = layoutTxt('他说了一句话，」\n她接了下去。');
check('对白：`，」` 结尾不误切', noEndQuote.paragraphs.length === 1, `→ ${noEndQuote.paragraphs.length}`);

// 引号前是句末标点但引号后还有字（句子未完）→ 仍按折行
const quoteMidLine = layoutTxt('他说：「好。」然后\n他又补了一句。');
check('对白：`。」` 后面还有字且行尾非标点 → 折行合并', quoteMidLine.paragraphs.length === 1, `→ ${quoteMidLine.paragraphs.length}`);

// ── 7) CRLF 与裸 \r ─────────────────────────────────────
// ⚠️ 夹具**原样保留 CRLF**，不要先归一化成 \n —— 那会恰好绕过主路径。
// 全库实测 83 本真实 txt 全是 CRLF，\r 归一化不是边角路径而是每本书的主路径。
const crlfText = '第一行没说完，\r\n第二行继续说完了。\r\n第三行。';
const crlf = layoutTxt(crlfText);
check('CRLF：切成 2 段', crlf.paragraphs.length === 2, `→ ${crlf.paragraphs.length}`);
check('CRLF：合并 1 个折行', crlf.stats.removedBreaks === 1, `→ ${crlf.stats.removedBreaks}`);
check('CRLF：renderText 不含 \\r', crlf.renderText.indexOf('\r') === -1);
const crlfCrPositions = crlfText
  .split('')
  .map((ch, i) => (ch === '\r' ? i : -1))
  .filter((i) => i >= 0);
check(
  'CRLF：所有 \\r 位置都记账',
  crlfCrPositions.length === 2 && crlfCrPositions.every((i) => crlf.removedPositions.includes(i)),
  `\\r 位置 ${JSON.stringify(crlfCrPositions)}`,
);
check(
  'CRLF：所有 \\n 位置都记账',
  [8, 19].every((i) => crlf.removedPositions.includes(i)),
  JSON.stringify(crlf.removedPositions),
);
check('CRLF：文本内容正确', crlf.renderText === '第一行没说完，第二行继续说完了。第三行。', JSON.stringify(crlf.renderText));

// CRLF 与等价 LF 文本必须渲染出同样的结果（归一化正确性的直接证据）
const lfTwin = layoutTxt('第一行没说完，\n第二行继续说完了。\n第三行。');
check(
  'CRLF 与 LF 渲染结果一致',
  crlf.renderText === lfTwin.renderText && crlf.paragraphs.length === lfTwin.paragraphs.length,
);

// \r 漏记会让全书偏移「每行错 1 位」且不报错 —— 这里逐行钉住行首映射不错位
const crlfLines = ['第一行没说完，', '第二行继续说完了。', '第三行。'];
let crlfLineAligned = true;
let crlfCursor = 0;
for (const line of crlfLines) {
  const at = fullToRender(crlf, crlfCursor);
  if (crlf.renderText.slice(at, at + line.length) !== line) crlfLineAligned = false;
  crlfCursor += line.length + 2; // \r\n
}
check('CRLF：每行行首偏移映射不错位', crlfLineAligned);

const bareCr = layoutTxt('前面没说完，\r后面接着说完了。');
check('裸 \\r：被删除', bareCr.renderText === '前面没说完，后面接着说完了。', JSON.stringify(bareCr.renderText));
check('裸 \\r：位置记账（1 个 \\r）', bareCr.removedPositions.length === 1 && bareCr.removedPositions[0] === 6, JSON.stringify(bareCr.removedPositions));
check('裸 \\r：末尾裸 \\r 也删', layoutTxt('abc\r').renderText === 'abc');

// ── 8) preserve 模式 ────────────────────────────────────
const preserveSrc = '　　第一行内容，\n第二行内容，\n\n第三行内容。';
const preserved = layoutTxt(preserveSrc, 'preserve');
check('preserve：3 个非空行 → 3 段', preserved.paragraphs.length === 3, `→ ${preserved.paragraphs.length}`);
check('preserve：零合并', preserved.stats.removedBreaks === 0);
check('preserve：shape 为 preserve', preserved.stats.shape === 'preserve');
check('preserve：段首缩进仍剥掉', preserved.renderText.startsWith('第一行内容，'), JSON.stringify(preserved.renderText));
check('preserve：renderText 不含换行', !/[\n\r]/.test(preserved.renderText));
// preserve 下每行独立成段，但行间换行仍必须删（渲染文本不能有换行）——两条语义不同，别混
const preserveNewlineCount = preserved.removedPositions.filter((p) => preserveSrc[p] === '\n').length;
check(
  'preserve：removedPositions 仍含全部 3 个换行',
  preserveNewlineCount === 3,
  `含 ${preserveNewlineCount} 个换行`,
);
check('preserve：不兜底（9.8 万字单行 → 1 段）', layoutTxt(hugeText, 'preserve').paragraphs.length === 1);
check('preserve：超长单行 shape 仍是 preserve', layoutTxt(hugeText, 'preserve').stats.shape === 'preserve');

// ── 9) 无换行兜底切段 ───────────────────────────────────
const huge = layoutTxt(hugeText);
check('无换行：段落数 > 100', huge.paragraphs.length > 100, `→ ${huge.paragraphs.length}`);
check(
  '无换行：每段 ≤ 800 字',
  huge.paragraphs.every((para) => para.renderEnd - para.renderStart <= 800),
  `最大 ${Math.max(...huge.paragraphs.map((p) => p.renderEnd - p.renderStart))}`,
);
check(
  '无换行：除末段外每段 ≥ 400 字',
  huge.paragraphs.slice(0, -1).every((para) => para.renderEnd - para.renderStart >= 400),
);
check('无换行：切段后文本拼接等于原文', huge.renderText === hugeText);
check('无换行：无折行合并', huge.stats.removedBreaks === 0);
check('无换行：shape 为 no-break', huge.stats.shape === 'no-break', huge.stats.shape);
check('无换行：非空行数为 1', huge.stats.rawLines === 1);

const dense = layoutTxt(denseOneLine);
check('单行 4200 字：shape 为 no-break（字符数/行数判据）', dense.stats.shape === 'no-break', dense.stats.shape);
check('单行 4200 字：也会被兜底切成多段', dense.paragraphs.length > 1, `→ ${dense.paragraphs.length}`);
check('单行 4200 字：每段 ≤ 800', dense.paragraphs.every((p) => p.renderEnd - p.renderStart <= 800));

// ── 9b) 代理对：兜底硬切不得把一个字符劈到两个 <p>（verifier 报的缺陷）──
/** 是否含孤立代理项（高代理项后面没跟低代理项，或凭空出现低代理项）。 */
function hasLoneSurrogate(source) {
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // 成对，跳过低代理项
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
// 402 个 Unicode 字符 = 803 个 UTF-16 码元：第 800 个码元正好是某个「𠀀」的高代理项，
// 旧实现会在这里硬切 → 孤立低代理项 + 替换字形。
const surrogateText = `甲${'𠀀'.repeat(401)}`;
const surrogate = layoutTxt(surrogateText);
check('代理对：确实触发了兜底切分（≥2 段）', surrogate.paragraphs.length >= 2, `→ ${surrogate.paragraphs.length}`);
check('代理对：renderText 与原文逐码元一致', surrogate.renderText === surrogateText);
check('代理对：整体无孤立代理项', !hasLoneSurrogate(surrogate.renderText));
check(
  '代理对：每个段文本都不含孤立代理项（未被劈开）',
  surrogate.paragraphs.every((para) => !hasLoneSurrogate(surrogate.renderText.slice(para.renderStart, para.renderEnd))),
);
check(
  '代理对：每段仍 ≤ 800 码元',
  surrogate.paragraphs.every((para) => para.renderEnd - para.renderStart <= 800),
  `最大 ${Math.max(...surrogate.paragraphs.map((p) => p.renderEnd - p.renderStart))}`,
);
check(
  '代理对：切点落在字符边界（段首不是低代理项）',
  surrogate.paragraphs.every((para) => {
    const first = surrogate.renderText.charCodeAt(para.renderStart);
    return !(first >= 0xdc00 && first <= 0xdfff);
  }),
);
check('代理对：html 内无孤立代理项', !hasLoneSurrogate(surrogate.html));
const emojiText = '𠀀'.repeat(500); // 1000 码元、无标点
const emoji = layoutTxt(emojiText);
check('代理对：全 emoji 无标点文本也不劈开', !hasLoneSurrogate(emoji.renderText) && emoji.renderText === emojiText);
check('代理对：全 emoji 每段 ≤ 800 码元', emoji.paragraphs.every((p) => p.renderEnd - p.renderStart <= 800));

// 反证：把代理对保护拿掉（模拟旧实现的「收满 800 码元就无条件切」）必然劈开码元 ——
// 证明上面那条断言不是空转，也把这个缺陷永久钉在测试里。
function legacyHardSplit(source, max) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < source.length; i += 1) {
    buf += source[i];
    if (buf.length >= max) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf !== '') parts.push(buf);
  return parts;
}
const legacyParts = legacyHardSplit(surrogateText, 800);
check(
  '反证：无保护的旧硬切确实劈开码元（防护必要，非空转）',
  legacyParts.length >= 2 && legacyParts.some((part) => hasLoneSurrogate(part)),
  `段长 ${JSON.stringify(legacyParts.map((part) => part.length))}`,
);

// ── 10) 偏移映射往返（property test）────────────────────
function roundTripCheck(label, text, mode) {
  const layout = layoutTxt(text, mode);
  const removed = new Set(layout.removedPositions);
  let forwardOk = true;
  let forwardCount = 0;
  for (let x = 0; x <= text.length; x += 1) {
    if (removed.has(x)) continue;
    const r = fullToRender(layout, x);
    forwardCount += 1;
    if (renderToFull(layout, r) !== x) {
      forwardOk = false;
      console.log(`    正向往返失败：full=${x} render=${r} back=${renderToFull(layout, r)}`);
      break;
    }
  }
  let backwardOk = true;
  for (let r = 0; r <= layout.renderText.length; r += 1) {
    const f = renderToFull(layout, r);
    if (fullToRender(layout, f) !== r) {
      backwardOk = false;
      console.log(`    反向往返失败：render=${r} full=${f} back=${fullToRender(layout, f)}`);
      break;
    }
  }
  check(`映射往返（${label}）：保留位置正向`, forwardOk, `覆盖 ${forwardCount} 个位置`);
  check(`映射往返（${label}）：渲染位置反向`, backwardOk, `覆盖 ${layout.renderText.length + 1} 个位置`);
  return layout;
}
const wrappedRound = roundTripCheck('折行型', wrappedText);
roundTripCheck('短段型', shortText);
roundTripCheck('CRLF', crlfText);
roundTripCheck('拖尾空格 + 缩进', trailingText);
roundTripCheck('对白', '「我等你。」\n「好。」');
roundTripCheck('代理对', surrogateText);
roundTripCheck('preserve', preserveSrc, 'preserve');

check(
  '被删位置映射到其右侧第一个保留字符',
  fullToRender(wrappedRound, wrappedRound.removedPositions[0]) === 0,
  `→ ${fullToRender(wrappedRound, wrappedRound.removedPositions[0])}`,
);
// 行 1 的换行被删（在段内），它后面的字符应立即在渲染文本里出现
const firstRemovedNewline = wrappedRound.removedPositions.find((p) => wrappedText[p] === '\n');
check(
  '折行换行处不发生错位',
  wrappedRound.renderText.slice(fullToRender(wrappedRound, firstRemovedNewline), fullToRender(wrappedRound, firstRemovedNewline) + 1) ===
    WRAP_LINE.charAt(0),
);
check('越界收敛：fullToRender(-5) = 0', fullToRender(wrappedRound, -5) === 0);
check(
  '越界收敛：fullToRender(超大值) = renderText.length',
  fullToRender(wrappedRound, 1e9) === wrappedRound.renderText.length,
);
// wrappedText 开头是两个全角缩进（位置 0、1 被删），所以 render 偏移 0 对应原文偏移 2 ——
// 「renderToFull(0) 就是 0」是错的，别把它当成边界收敛来断言。
const firstKeptOffset = wrappedText.split('').findIndex((_, i) => !wrappedRound.removedPositions.includes(i));
check(
  '越界收敛：renderToFull(-3) = 第一个保留位置的原文偏移',
  renderToFull(wrappedRound, -3) === firstKeptOffset && renderToFull(wrappedRound, 0) === firstKeptOffset,
  `→ ${renderToFull(wrappedRound, -3)}，firstKept=${firstKeptOffset}`,
);
check('越界收敛：renderToFull(超大值) = 原文长度', renderToFull(wrappedRound, 1e9) === wrappedText.length);
check(
  '非数字偏移收敛到两端',
  fullToRender(wrappedRound, Number.NaN) === 0 && renderToFull(wrappedRound, Number.NaN) === firstKeptOffset,
);
// ── 11) 不变量与结构约束 ────────────────────────────────
for (const [label, layout, sourceLength] of [
  ['折行型', wrapped, wrappedText.length],
  ['短段型', short, shortText.length],
  ['空行型', blank, blankText.length],
  ['拖尾空格', trailing, trailingText.length],
  ['对白', dialogueHard, '「我等你。」\n「好。」'.length],
  ['代理对', surrogate, surrogateText.length],
  ['CRLF', crlf, crlfText.length],
  ['preserve', preserved, preserveSrc.length],
  ['兜底切段', huge, hugeText.length],
]) {
  check(`不变量（${label}）：renderText = 去标签反转义(html)`, textOfHtml(layout.html) === layout.renderText);
  check(`不变量（${label}）：html 内无换行`, !/[\n\r]/.test(layout.html));
  check(`不变量（${label}）：<p> 数 = 段落数`, paragraphTagsOf(layout.html) === layout.paragraphs.length);
  check(`不变量（${label}）：renderText 无换行`, !/[\n\r]/.test(layout.renderText));
  check(`不变量（${label}）：removedPositions 严格升序`, isStrictlyAscending(layout.removedPositions));
  check(
    `不变量（${label}）：段落区间长度关系`,
    layout.paragraphs.every(
      (para) =>
        para.renderEnd - para.renderStart ===
        para.fullEnd - para.fullStart - layout.removedPositions.filter((p) => p >= para.fullStart && p < para.fullEnd).length,
    ),
  );
  check(
    `不变量（${label}）：段落升序不重叠`,
    layout.paragraphs.every((para, i) => {
      if (para.fullEnd <= para.fullStart || para.renderEnd < para.renderStart) return false;
      const next = layout.paragraphs[i + 1];
      return next === undefined || (para.fullEnd <= next.fullStart && para.renderEnd <= next.renderStart);
    }),
  );
  check(
    `不变量（${label}）：原文长度 = renderText + 被删数`,
    layout.renderText.length + layout.removedPositions.length === sourceLength,
    `${layout.renderText.length} + ${layout.removedPositions.length} vs ${sourceLength}`,
  );
}

// ── 12) escapeHtmlText ──────────────────────────────────
check('escapeHtmlText：转义 & < >', escapeHtmlText('a&b<c>d') === 'a&amp;b&lt;c&gt;d', escapeHtmlText('a&b<c>d'));
check('escapeHtmlText：不转义引号', escapeHtmlText('他说"好"') === '他说"好"');
check('escapeHtmlText：空串', escapeHtmlText('') === '');
check('escapeHtmlText：无特殊字符原样返回', escapeHtmlText('普通正文') === '普通正文');
check('escapeHtmlText：& 只转一次', escapeHtmlText('&amp;') === '&amp;amp;', escapeHtmlText('&amp;'));

const escaped = layoutTxt('他写了<标签>和&符号。');
check('html 转义：标签被转义', escaped.html.includes('&lt;标签&gt;') && !escaped.html.includes('<标签>'));
check('html 转义：renderText 保留原文', escaped.renderText === '他写了<标签>和&符号。', JSON.stringify(escaped.renderText));
check('html 转义：不变量仍成立', textOfHtml(escaped.html) === escaped.renderText);

// ── 13) 性能（O(n)）────────────────────────────────────
console.log(`\n性能样本：${perfText.length} 字 / ${perfLines.length} 行`);
const perfStart = performance.now();
const PERF_RUNS = 5;
for (let i = 0; i < PERF_RUNS; i += 1) layoutTxt(perfText);
const perfAvg = (performance.now() - perfStart) / PERF_RUNS;
check('性能：3.7 万字 auto 单次 < 30ms', perfAvg < 30, `实测均值 ${perfAvg.toFixed(2)}ms`);

const perfPreserveStart = performance.now();
for (let i = 0; i < PERF_RUNS; i += 1) layoutTxt(perfText, 'preserve');
const perfPreserveAvg = (performance.now() - perfPreserveStart) / PERF_RUNS;
check('性能：3.7 万字 preserve 单次 < 30ms', perfPreserveAvg < 30, `实测均值 ${perfPreserveAvg.toFixed(2)}ms`);

// 真实书 83/83 全是 CRLF，\r 归一化是主路径而非边角，性能也要按 CRLF 量一次
const perfCrlfText = perfLines.join('\r\n');
const perfCrlfStart = performance.now();
for (let i = 0; i < PERF_RUNS; i += 1) layoutTxt(perfCrlfText);
const perfCrlfAvg = (performance.now() - perfCrlfStart) / PERF_RUNS;
check('性能：3.7 万字 CRLF 单次 < 30ms', perfCrlfAvg < 30, `实测均值 ${perfCrlfAvg.toFixed(2)}ms`);
check('性能：CRLF 与 LF 样本渲染结果一致', layoutTxt(perfCrlfText).renderText === layoutTxt(perfText).renderText);

const hugeStart = performance.now();
layoutTxt(hugeText);
const hugeMs = performance.now() - hugeStart;
check('性能：9.8 万字无换行 + 兜底切段 < 200ms', hugeMs < 200, `实测 ${hugeMs.toFixed(2)}ms`);

console.log(`\n共 ${total} 条断言`);
console.log(allPass ? 'txt-layout 自测全部通过' : '存在失败用例');
process.exit(allPass ? 0 : 1);
