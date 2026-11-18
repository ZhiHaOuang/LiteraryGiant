export const pagesZh = {
  empty: '点击此栏，再从侧栏打开页面', split: '左右分栏', full: '最多两个分栏', narrow: '空间不足以分栏',
  close: '关闭标签', add: '选择此栏', dock: '回到分栏', left: '左侧', right: '右侧', top: '上方', bottom: '下方', center: '移入此栏',
  conversation: 'Agent 对话', move: '移到另一栏', locked: '有未保存内容或待确认操作',
}
export const pagesEn: Record<keyof typeof pagesZh, string> = {
  empty: 'Select this pane, then open a page from the sidebar', split: 'Split right', full: 'Two panes maximum', narrow: 'Not enough room to split',
  close: 'Close tab', add: 'Select pane', dock: 'Dock', left: 'Left', right: 'Right', top: 'Above', bottom: 'Below', center: 'Move here',
  conversation: 'Agent conversation', move: 'Move to other pane', locked: 'Unsaved content or pending action',
}
