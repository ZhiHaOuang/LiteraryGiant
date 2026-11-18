/**
 * 划线的 DOM 交互（纯函数，依赖注入 document/Selection，便于 jsdom 单测）。
 *
 * 职责边界：
 * - 采集：从用户选区取出「覆盖的文本节点 + 各节点内偏移」，据此算出
 *   「单元纯文本里的字符偏移」——这是跨重排定位的基础；
 * - 恢复：按字符偏移在单元文本里找到位置，再把对应的文本节点区间包上高亮。
 *
 * 不在这里做：网络、状态管理、React 渲染。
 */

/** 单元内一个文本节点的快照（恢复高亮时按顺序重新走一遍）。 */
export interface TextNodeSlice {
  /** 该节点拼接进单元文本前的累计偏移。 */
  start: number;
  /** 节点文本。 */
  text: string;
  /** 节点在 DOM 里的序号（按 document order）。 */
  index: number;
}

/** 把一段 DOM 的文本内容拼成「单元纯文本」，同时记录每个文本节点的区间。 */
export function collectTextSlices(root: Element): { text: string; slices: TextNodeSlice[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const slices: TextNodeSlice[] = [];
  let text = '';
  let index = 0;
  let node = walker.nextNode();
  while (node !== null) {
    const value = node.nodeValue ?? '';
    if (value !== '') {
      slices.push({ start: text.length, text: value, index });
      text += value;
    }
    index += 1;
    node = walker.nextNode();
  }
  return { text, slices };
}

/** 采集结果（带 DOM 节点引用，供高亮恢复使用）。 */
export interface CollectedFlow {
  text: string;
  nodes: Array<{ node: Text; start: number; text: string }>;
}

/** 带 DOM 引用的采集（与 collectTextSlices 同逻辑，多留节点引用）。 */
export function collectFlowText(root: Element): CollectedFlow {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: CollectedFlow['nodes'] = [];
  let text = '';
  let node = walker.nextNode();
  while (node !== null) {
    const value = node.nodeValue ?? '';
    if (value !== '') {
      nodes.push({ node: node as Text, start: text.length, text: value });
      text += value;
    }
    node = walker.nextNode();
  }
  return { text, nodes };
}

/** 当前选区是否是有效的正文划线（非折叠、非纯空白）。 */
export function hasMeaningfulSelection(selection: Selection | null): boolean {
  if (selection === null || selection.isCollapsed) return false;
  return selection.toString().trim() !== '';
}

/**
 * 计算选区在「单元纯文本」里的偏移与长度。
 * 选区可能从某个文本节点中段开始、在另一个节点中段结束，
 * 因此逐节点累加：首节点取 endOffset 之后的部分，末节点取到 startOffset 为止。
 *
 * 返回 undefined 表示选区不在 root 内（比如选到了工具栏）。
 */
export function selectionOffsetInFlow(
  root: Element,
  selection: Selection,
): { offset: number; length: number } | undefined {
  if (selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== root) {
    return undefined;
  }
  const flow = collectFlowText(root);
  if (flow.nodes.length === 0) return undefined;

  // 起点节点与偏移
  const startNode = range.startContainer;
  const startIndex = flow.nodes.findIndex((entry) => entry.node === startNode);
  const endIndex = flow.nodes.findIndex((entry) => entry.node === range.endContainer);
  if (startIndex < 0 || endIndex < 0) return undefined;

  const startEntry = flow.nodes[startIndex]!;
  const endEntry = flow.nodes[endIndex]!;
  const startOffset = startEntry.start + Math.min(range.startOffset, startEntry.text.length);
  const endOffset = endEntry.start + Math.min(range.endOffset, endEntry.text.length);
  if (endOffset <= startOffset) return undefined;
  return { offset: startOffset, length: endOffset - startOffset };
}

/** 高亮标记的 class 与 data 属性名。 */
export const MARK_CLASS = 'dsh-reading-mark';
export const MARK_ID_ATTR = 'data-dsh-mark-id';

/**
 * 在单元 DOM 上恢复一批高亮：按字符区间包裹文本节点片段。
 *
 * 实现走「逐节点切分」而不是 Range.surroundContents —— 后者跨节点选区会抛错，
 * 且划线常跨段落。返回成功恢复的划线 id（找不到区间的条目静默跳过）。
 */
export function applyMarks(
  root: Element,
  marks: Array<{ id: string; offset: number; length: number }>,
): string[] {
  // 先清掉旧标记（重排/换章后 DOM 是新的，但保险起见统一清理）
  for (const old of Array.from(root.querySelectorAll(`.${MARK_CLASS}`))) {
    const parent = old.parentNode;
    if (parent === null) continue;
    while (old.firstChild !== null) parent.insertBefore(old.firstChild, old);
    parent.removeChild(old);
    parent.normalize();
  }

  const flow = collectFlowText(root);
  const restored: string[] = [];
  for (const mark of marks) {
    if (mark.length <= 0) continue;
    const end = mark.offset + mark.length;
    let ok = false;
    for (const entry of flow.nodes) {
      const nodeStart = entry.start;
      const nodeEnd = entry.start + entry.text.length;
      if (nodeEnd <= mark.offset || nodeStart >= end) continue;
      const from = Math.max(0, mark.offset - nodeStart);
      const to = Math.min(entry.text.length, end - nodeStart);
      if (to <= from) continue;
      const node = entry.node;
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const wrapper = document.createElement('mark');
      wrapper.className = MARK_CLASS;
      wrapper.setAttribute(MARK_ID_ATTR, mark.id);
      try {
        range.surroundContents(wrapper);
        ok = true;
      } catch {
        // 包裹失败（比如跨元素边界）：退化为整段着色
        try {
          wrapper.appendChild(range.extractContents());
          range.insertNode(wrapper);
          ok = true;
        } catch {
          // 内容不可包裹（极端情况）：跳过该节点片段
        }
      }
    }
    if (ok) restored.push(mark.id);
  }
  return restored;
}

/** 从 DOM 元素反查划线 id（笔记栏「定位」跳转用）。 */
export function markIdOfElement(element: Element): string | undefined {
  const hit = element.closest(`.${MARK_CLASS}`);
  return hit?.getAttribute(MARK_ID_ATTR) ?? undefined;
}
