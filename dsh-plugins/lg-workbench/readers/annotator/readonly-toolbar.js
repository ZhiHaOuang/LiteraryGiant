// LG trial: the upstream file-edit toolbar is replaced because chapters are read-only snapshots.
function MdToolbar(props) {
  return React.createElement('div',{className:'mdan-toolbar',role:'toolbar','aria-label':'Markdown 工具栏'},
    React.createElement('span',null,'Markdown 批注 · 章节只读'),
    React.createElement('span',{className:'mdan-source-status'},'批注仅保留在本次试用窗口；切换方案或关闭后不保存'))
}
