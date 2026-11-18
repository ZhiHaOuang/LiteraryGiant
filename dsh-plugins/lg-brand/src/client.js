import {bindWorkspaceBooks} from './workspace-navigation.js'
import workspaceStyles from './workspace-sidebar.css'
import { createElement } from 'react'
export const inject = ['slots']
const icon = "data:image/jpeg;base64,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"
function Mark({ size }) {
  return createElement('img', { src: icon, width: size, height: size, alt: '', style: { borderRadius: '25%' } })
}
function Name() {
  return createElement('span', null, 'LiteraryGiant')
}
/** Slot registrations are owned and disposed by this Cordis plugin fiber. */
export function apply(ctx) {
  ctx.effect(()=>{
    const style=document.createElement('style');style.textContent=workspaceStyles;document.head.appendChild(style)
    return ()=>style.remove()
  },'lg-brand: workspace hierarchy')
  ctx.inject(['workspaces','literaryDashboard'],scope=>scope.effect(()=>bindWorkspaceBooks({
    workspaces:scope.workspaces,document,window,
    async readBooks(signal){
      const response=await fetch('api/lg/books',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'list'}),signal})
      const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'Book lookup failed')
      return data.value
    },
    openBook:path=>scope.literaryDashboard.openBook(path),
  }),'lg-brand: workspace book links'))
  ctx.inject(['contextMenus','workspaces','literaryDashboard','locale'],scope=>scope.effect(()=>scope.contextMenus.register({
    id:'lg.book-dashboard',target:'workspace',order:50,
    resolve:({workspaceId})=>[{id:'dashboard',label:scope.locale.getLocale?.().active==='zh'?'本书 Dashboard':'Book dashboard',
      run:()=>{const workspace=scope.workspaces.list.getSnapshot().items.find(w=>w.workspaceId===workspaceId);if(workspace)scope.literaryDashboard.openBook(workspace.path)}}],
  }),'lg-brand: workspace menu'))
  ctx.effect(()=>{
    const style=document.createElement('style')
    style.textContent=`
/* The host paints panel-entry; keep spacing outside that painted box. */
body[data-dsh-claude-style] [data-dsh-claude-part~="panel-entry"] > button[data-dsh-claude-part~="panel-row"],
body[data-dsh-claude-style][data-ds-dark-theme] [data-dsh-claude-part~="panel-entry"] > button[data-dsh-claude-part~="panel-row"]:hover {
  margin:0 !important;
  background:transparent !important;
}
body[data-dsh-claude-style] [data-dsh-claude-part~="layout-frame"]:not([data-sidebar-collapsed]) [data-dsh-claude-part~="panel-entry"] {
  margin-bottom:6px;
  border-radius:6px;
}
body[data-dsh-claude-style] [data-dsh-claude-part~="layout-frame"]:not([data-sidebar-collapsed]) [data-dsh-claude-part~="panel-entry"] > button:not([data-dsh-claude-part~="panel-row"]) {
  top:0;
}
body[data-dsh-claude-style] [data-dsh-claude-part~="layout-frame"]:not([data-sidebar-collapsed]) [data-dsh-claude-part~="panel-entry"]:has(> button:not([data-dsh-claude-part~="panel-row"])) > button[data-dsh-claude-part~="panel-row"] {
  padding-inline-end:32px;
}
body[data-dsh-claude-style][data-dsh-claude-sidebar-layout="compact"] [data-dsh-claude-part~="layout-frame"]:not([data-sidebar-collapsed]) [data-dsh-claude-part~="panel-entry"] {
  margin-bottom:2px;
}
body[data-dsh-claude-style] [data-dsh-claude-part~="layout-frame"][data-sidebar-collapsed] [data-dsh-claude-part~="panel-entry"] {
  margin-bottom:0;
  border-radius:12px;
}
`

    document.head.appendChild(style)
    return ()=>style.remove()
  }, 'lg-brand: sidebar wrapper geometry and single background')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', id: 'lg-brand-mark' }, Mark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', id: 'lg-brand-name' }, Name)
    }))
}
