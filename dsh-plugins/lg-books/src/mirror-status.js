export const states = {
  'recover-committed':'旧导入的正文已保存，同步基线待恢复', 'recover-import':'旧导入在保存正文前中断',
  missing: '还没有章节文件', clean: '文件与作品一致', 'file-edited': '外部文件有修改',
  'database-changed': '作品已有新版本', conflict: '文件和作品都已修改', untracked: '已有文件尚未登记',
}

export function mirrorStatus(receipt) {
  const saved = receipt.action === 'structure-mirror' ? '规划已保存' : '正文已保存'
  if (receipt.sync === 'upgrade-required') return '规划已保存，请升级 lg-books 后在章节文件中同步。'
  if (receipt.action !== 'structure-mirror' && !receipt.changesManuscript) return '当前正文保持原样。'
  if (receipt.sync === 'synchronized') return saved + '，章节文件已同步：' + receipt.mirrorPath + (receipt.backup ? '。原文件备份：' + receipt.backup : '')
  if (receipt.sync === 'mirror-review') return saved + '，外部文件待核对。' + (states[receipt.mirrorState] ?? '') + '，请打开「章节文件」比较。'
  if (receipt.sync === 'mirror-pending') return saved + '，文件同步尚未完成。请在「章节文件」重试。' + (receipt.syncError ?? '')
  if (receipt.sync === 'superseded') return '此同步操作已被后续变更接替。'
  return saved + '，请在「章节文件」查看同步状态。'
}
