// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { MainPages } from '../src/client/MainPages.tsx'
import type { PageOwnerProps } from '../src/client/pages.ts'
import { PageWorkspace } from '../src/client/pages.ts'
import type { MainPanelId } from '../src/client/service.ts'
import { pagesEn } from '../src/client/page-locales.ts'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('unmounts replaced pages and their actions, with a plain draggable title instead of page history',()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}unobserve(){}})
 const pages=new PageWorkspace(vi.fn()),panel='dashboard' as MainPanelId
 const first=pages.open(panel,{key:'a',title:'Book A'})
 const usePages=bindSnapshotSelector(pages.source),clicked=vi.fn()
 const view=render(<MainPages usePages={usePages} pageActions={pages.intents}
  updatePage={(id,options)=>pages.update(id,options)} lockPage={(id,value)=>pages.lock(id,value)}
  closePane={id=>pages.closePane(id)} pageLabels={key=>pagesEn[key]}
  useSessions={selector=>selector({ids:[],byId:{},projectionsBySession:{},phase:'ready'})}
  renderSlot={(_key,{page,pageChrome}:PageOwnerProps)=><div>
   {pageChrome!.actions!(<button onClick={()=>clicked(page!.key)}>Refresh {page!.title}</button>)}
   <input aria-label={`Draft ${page!.title}`} defaultValue="retained"/>
  </div>}/> )
 expect(view.container.querySelector('[data-lg-page-title]')?.tagName).toBe('SPAN')
 fireEvent.click(view.getByText('Book A'));expect(view.queryByRole('menu')).toBeNull()
 act(()=>{pages.open(panel,{key:'b',title:'Book B'})})
 expect(view.queryByLabelText('Draft Book A')).toBeNull()
 expect(view.queryByRole('button',{name:'Refresh Book A'})).toBeNull()
 const draft=view.getByLabelText('Draft Book B')
 fireEvent.change(draft,{target:{value:'unsaved'}})
 const b=pages.active!.id
 act(()=>{pages.lock(b,true);pages.open(panel,{key:'c',title:'Book C'})})
 expect(view.queryByLabelText('Draft Book C')).toBeNull()
 expect(view.getByRole('button',{name:'Close pane'})).toHaveProperty('disabled',true)
 act(()=>{pages.open(panel,{key:'c',title:'Book C',placement:'split'})})
 const headers=view.container.querySelectorAll<HTMLElement>('[data-lg-pane-header]')
 expect(headers).toHaveLength(2)
 for(const header of headers)fireEvent.click(within(header).getByRole('button',{name:/Refresh/}))
 expect(clicked.mock.calls.map(([key])=>key).sort()).toEqual(['b','c'])
 act(()=>pages.closePane(pages.source.getSnapshot().layout.activePaneId))
 expect(view.getByLabelText('Draft Book B')).toBe(draft)
 expect(draft).toHaveProperty('value','unsaved')
 expect(view.queryByRole('button',{name:'Refresh Book C'})).toBeNull()
 act(()=>pages.focusTab(first));expect(pages.active?.id).toBe(b)
})
