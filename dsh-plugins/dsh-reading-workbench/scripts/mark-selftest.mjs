/**
 * 划线自测：锚点编解码（纯函数）+ DOM 高亮恢复（jsdom 真选区）。
 *
 * 覆盖：
 * - mark 锚点编码/解析/非法输入；
 * - 选区 → 单元文本偏移（跨节点、节点中段起止）；
 * - 按偏移恢复高亮（跨段落、部分覆盖节点）；
 * - 删除高亮（清除包裹、合并回文本节点）；
 * - 归一化选区文本（空白折叠、超长截断）。
 *
 * 用法：node scripts/mark-selftest.mjs
 */
import { JSDOM } from 'jsdom';

// DOMPurify/TreeWalker 需要全局 DOM，先建环境再导入被测模块
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Range = dom.window.Range;

const {
  encodeMarkAnchor,
  parseMarkAnchor,
  normalizeSelectionText,
  isStaleMark,
  MAX_MARK_LENGTH,
} = await import('../src/shared/mark-anchor.ts');
const {
  collectFlowText,
  applyMarks,
  MARK_CLASS,
  MARK_ID_ATTR,
  selectionOffsetInFlow,
} = await import('../src/client/marks.ts');

let allPass = true;
/** 断言打印。 */
function check(name, condition, detail) {
  allPass = allPass && condition;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
}

/** 建一个挂到 document 的正文容器（jsdom 必须挂在文档树上 TreeWalker 才可靠）。 */
function mount(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

// ── 1) 锚点编解码 ──
check('章节书锚点编码', encodeMarkAnchor({ chapter: 2, offset: 17, length: 9 }) === 'mark:ch=2:off=17:len=9', encodeMarkAnchor({ chapter: 2, offset: 17, length: 9 }));
check('文本类锚点编码', encodeMarkAnchor({ offset: 3, length: 6 }) === 'mark:off=3:len=6');
const roundTrip = parseMarkAnchor(encodeMarkAnchor({ chapter: 5, offset: 120, length: 30 }));
check('锚点往返', roundTrip?.chapter === 5 && roundTrip?.offset === 120 && roundTrip?.length === 30, JSON.stringify(roundTrip));
check('非 mark 锚点返回 undefined', parseMarkAnchor('chapter:3') === undefined && parseMarkAnchor('v2;page=1;pct=0') === undefined);
check('缺字段返回 undefined', parseMarkAnchor('mark:ch=1:off=5') === undefined);
check('非法输入返回 undefined', parseMarkAnchor(undefined) === undefined && parseMarkAnchor('') === undefined);
check('负数段被拒绝（而非收敛）', parseMarkAnchor('mark:off=-3:len=9') === undefined);

// ── 2) 归一化与过期判定 ──
check('空白折叠', normalizeSelectionText('  甲\n\n 乙\t丙  ') === '甲 乙 丙', normalizeSelectionText('  甲\n\n 乙\t丙  '));
const longText = '字'.repeat(MAX_MARK_LENGTH + 50);
check('超长截断到上限', normalizeSelectionText(longText).length === MAX_MARK_LENGTH, `len=${normalizeSelectionText(longText).length}`);
check('过期判定', isStaleMark({ offset: 10, length: 5 }, 14) === true && isStaleMark({ offset: 10, length: 5 }, 15) === false);

// ── 3) 单元文本采集 ──
const hostA = mount('<p>第一段落。</p><p>第二段落。</p>');
const flowA = collectFlowText(hostA);
check('纯文本拼接保留全部字符', flowA.text === '第一段落。第二段落。', flowA.text);
check('按文本节点切片', flowA.nodes.length === 2, `${flowA.nodes.length} 个文本节点`);
check('第二节点起点正确', flowA.nodes[1]?.start === 5, `start=${flowA.nodes[1]?.start}`);

// ── 4) 选区偏移（跨节点、节点中段）──
function selectRange(host, startContainer, startOffset, endContainer, endOffset) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(startContainer, startOffset);
  range.setEnd(endContainer, endOffset);
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection ?? null;
}

// 选「第一段」的后两个字到「第二段」的前三个字：段一 3..5，段二 0..3
const p1 = hostA.querySelectorAll('p')[0]?.firstChild;
const p2 = hostA.querySelectorAll('p')[1]?.firstChild;
const sel1 = selectRange(hostA, p1, 2, p2, 3);
const hit1 = selectionOffsetInFlow(hostA, sel1);
check('跨节点选区偏移正确', hit1?.offset === 2 && hit1?.length === 6, JSON.stringify(hit1));

// 选区不在容器内 → undefined
const selOutside = selectRange(document.body, document.body, 0, document.body, 0);
check('容器外选区返回 undefined', selectionOffsetInFlow(hostA, selOutside) === undefined);

// ── 5) 高亮恢复（按偏移包裹，跨段落）──
const hostB = mount('<p>床前明月光，疑是地上霜。</p><p>举头望明月，低头思故乡。</p>');
// 「光」在单元文本里的索引是 4（床0 前1 明2 月3 光4），取到「地上」止
const restored = applyMarks(hostB, [{ id: 'm1', offset: 4, length: 6 }]);
check('恢复返回划线 id', restored.includes('m1'), JSON.stringify(restored));
const marks1 = hostB.querySelectorAll(`.${MARK_CLASS}`);
check('生成高亮元素', marks1.length >= 1, `${marks1.length} 个`);
check('高亮带划线 id', marks1[0]?.getAttribute(MARK_ID_ATTR) === 'm1');
const flowAfter = collectFlowText(hostB);
check('高亮不改变单元文本', flowAfter.text === '床前明月光，疑是地上霜。举头望明月，低头思故乡。', flowAfter.text);
// 「床前明月光」：床0 前1 明2 月3 光4 —— offset 4 即「光」，取 6 字得「光，疑是地上」
check('高亮文本正确', flowAfter.text.slice(4, 10) === '光，疑是地上', flowAfter.text.slice(4, 10));

// 重复恢复不叠加：先清再包
const restored2 = applyMarks(hostB, [{ id: 'm2', offset: 0, length: 4 }]);
check('重复应用会清理旧标记', hostB.querySelectorAll(`.${MARK_CLASS}`).length === 1, `${hostB.querySelectorAll(`.${MARK_CLASS}`).length} 个`);
check('第二轮 id 正确', hostB.querySelector(`.${MARK_CLASS}`)?.getAttribute(MARK_ID_ATTR) === 'm2' && restored2.includes('m2'));

// ── 6) 清除高亮（传空数组 = 全部移除）──
applyMarks(hostB, []);
check('清除后无残留 mark', hostB.querySelectorAll(`.${MARK_CLASS}`).length === 0);
check('清除后文本仍完整', collectFlowText(hostB).text === '床前明月光，疑是地上霜。举头望明月，低头思故乡。');

// ── 7) 越界/零长划线被安全跳过 ──
const hostC = mount('<p>短句。</p>');
const restored3 = applyMarks(hostC, [
  { id: 'm-beyond', offset: 100, length: 4 },
  { id: 'm-zero', offset: 0, length: 0 },
]);
check('越界与零长划线不恢复', restored3.length === 0, JSON.stringify(restored3));
check('越界时 DOM 未被破坏', collectFlowText(hostC).text === '短句。');

// 清理挂载节点
for (const node of [hostA, hostB, hostC]) node.remove();

console.log(allPass ? '\n划线自测全部通过' : '\n存在失败用例');
process.exit(allPass ? 0 : 1);
