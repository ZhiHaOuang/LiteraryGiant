import { expect, it, vi } from 'vitest'
import { PageWorkspace } from '../src/client/pages.ts'
import type { MainPanelId } from '../src/client/service.ts'
import { dockPaneCount, findTabPane } from '@deepseek-ai/dsh-client-ui-dockkit'
const dashboard='dashboard' as MainPanelId,editor='editor' as MainPanelId
it('replaces the current page atomically without accumulating hidden pages',()=>{
 const selected=vi.fn(),pages=new PageWorkspace(selected)
 const previous=pages.open(editor,{key:'a:1'})
 const snapshots:number[]=[]
 pages.source.subscribe(()=>snapshots.push(Object.keys(pages.source.getSnapshot().pages).length))
 const current=pages.open(dashboard,{key:'global'})
 expect(current).not.toBe(previous)
 expect(pages.source.getSnapshot().pages[previous]).toBeUndefined()
 expect(snapshots).toEqual([1])
 for(let i=0;i<20;i++)pages.open(editor,{key:String(i)})
 expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(1)
 expect(()=>pages.focusTab(previous)).not.toThrow()
})
it('opens cross-book pages in the other column, then only replaces the focused column',()=>{
 const pages=new PageWorkspace(vi.fn())
 const left=pages.open(dashboard,{key:'global',scope:'pane'})
 const book=pages.open(editor,{key:'b:1',placement:'split'})
 const rightPane=pages.source.getSnapshot().layout.activePaneId
 const replacement=pages.open(editor,{key:'c:1'})
 expect(pages.source.getSnapshot().pages[book]).toBeUndefined()
 expect(pages.source.getSnapshot().pages[left]).toBeDefined()
 expect(findTabPane(pages.source.getSnapshot().layout,replacement).id).toBe(rightPane)
 expect(dockPaneCount(pages.source.getSnapshot().layout)).toBe(2)
 expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(2)
})
it('reveals a unique chapter without duplication or an empty speculative split',()=>{
 const pages=new PageWorkspace(vi.fn())
 const chapter=pages.open(editor,{key:'a:1',target:{version:1}})
 expect(pages.open(editor,{key:'a:1',placement:'split',target:{version:2}})).toBe(chapter)
 expect(dockPaneCount(pages.source.getSnapshot().layout)).toBe(1)
 expect(pages.active?.target.version).toBe(2)
 pages.open(dashboard,{placement:'split'})
 expect(pages.open(editor,{key:'a:1'})).toBe(chapter)
 expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(2)
})
it('blocks replacing or closing unsaved work, but still permits opening the other column',()=>{
 const pages=new PageWorkspace(vi.fn())
 const draft=pages.open(editor,{key:'a:1',target:{version:1}})
 const left=pages.source.getSnapshot().layout.activePaneId
 pages.lock(draft,true)
 expect(pages.open(dashboard)).toBe(draft)
 expect(pages.update(draft,{key:'a:2'})).toBe(false)
 pages.open(editor,{key:'a:1',target:{version:2}})
 pages.closePane(left)
 expect(pages.active?.target.version).toBe(1)
 const other=pages.open(dashboard,{placement:'split'})
 expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(2)
 pages.closeTab(other)
 expect(pages.active?.id).toBe(draft)
 pages.lock(draft,false)
 pages.open(dashboard)
 expect(pages.source.getSnapshot().pages[draft]).toBeUndefined()
})
it('prevents a chapter picker from duplicating the chapter in the other column',()=>{
 const pages=new PageWorkspace(vi.fn())
 const a=pages.open(editor,{key:'a:1'})
 const b=pages.open(editor,{key:'a:2',placement:'split'})
 expect(pages.update(b,{key:'a:1'})).toBe(false)
 expect(pages.active?.id).toBe(a)
 expect(pages.source.getSnapshot().pages[b]?.key).toBe('a:2')
})
it('supports pane-local Dashboards and repeated native sidebar navigation',()=>{
 const pages=new PageWorkspace(vi.fn())
 const left=pages.open(dashboard,{key:'global',scope:'pane'})
 const right=pages.open(dashboard,{key:'global',scope:'pane',placement:'split'})
 expect(right).not.toBe(left)
 expect(pages.open(dashboard,{key:'global'})).toBe(right)
 expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(2)
})
it('closing either column preserves its sibling and ignores delayed events from removed pages',()=>{
 for(const focused of [true,false]){
  const pages=new PageWorkspace(vi.fn())
  const a=pages.open(dashboard),left=pages.source.getSnapshot().layout.activePaneId
  const b=pages.open(editor,{placement:'split'}),right=pages.source.getSnapshot().layout.activePaneId
  if(!focused)pages.focusPane(left)
  pages.closePane(right)
  expect(dockPaneCount(pages.source.getSnapshot().layout)).toBe(1)
  expect(pages.active?.id).toBe(a)
  expect(()=>{pages.focusTab(b);pages.focusPane(right);pages.closePane(right);pages.closeTab(b)}).not.toThrow()
  pages.closeTab(a)
  expect(pages.active).toBeUndefined()
  expect(()=>pages.open(editor)).not.toThrow()
 }
})
it('resizing does not navigate',()=>{
 const selected=vi.fn(),pages=new PageWorkspace(selected)
 pages.open(dashboard);pages.open(editor,{placement:'split'})
 const root=pages.source.getSnapshot().layout.nodes[pages.source.getSnapshot().layout.rootId]!
 if(root.kind!=='split')throw Error('expected split')
 selected.mockClear();pages.intents.resizeSplit(root.id,[.4,.6]);expect(selected).not.toHaveBeenCalled()
})
