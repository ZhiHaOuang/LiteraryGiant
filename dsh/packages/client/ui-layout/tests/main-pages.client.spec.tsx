// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { MainPages } from '../src/client/MainPages.tsx'
import type { PageOwnerProps } from '../src/client/pages.ts'
import { PageWorkspace } from '../src/client/pages.ts'
import type { MainPanelId } from '../src/client/service.ts'
import type { ComponentProps } from 'react'
import { pagesEn } from '../src/client/page-locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps a draft mounted across tab switches and pane moves, and focuses a pane before its button navigates', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  const pages = new PageWorkspace(vi.fn())
  const first = pages.open('editor' as MainPanelId, { key: 'book-a:1', title: 'Book A' })
  const usePages = bindSnapshotSelector(pages.source)
  const props: ComponentProps<typeof MainPages> = {
    usePages, pageActions: pages.intents,
    updatePage: (id, options) => pages.update(id, options), lockPage: (id, value) => pages.lock(id, value),
    movePage: id => pages.moveToOtherPane(id), pageLabels: key => pagesEn[key],
    useSessions: selector => selector({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }),
    renderSlot: (_key, { page }: PageOwnerProps) => <div><input aria-label={page!.title} defaultValue="draft"/>
      <button onClick={() => pages.open('dashboard' as MainPanelId, {key:'book-c',title:'Book C'})}>Open C</button></div>,
  }
  const view = render(<MainPages {...props}/>)
  const input = view.getByLabelText('Book A')
  fireEvent.change(input, {target:{value:'unsaved draft'}})
  let second = first
  act(() => { second = pages.open('editor' as MainPanelId, { key:'book-b:1', title:'Book B' }) })
  expect(view.getByLabelText('Book A')).toBe(input)
  act(() => { pages.focusTab(first); pages.moveToOtherPane(second) })
  expect(view.getByLabelText('Book A')).toHaveProperty('value', 'unsaved draft')
  const a = view.container.querySelector(`[data-lg-page="${first}"]`)!
  const button = a.querySelector('button')!
  fireEvent.pointerDown(button)
  const focused = pages.source.getSnapshot().layout.activePaneId
  fireEvent.click(button)
  expect(pages.active?.key).toBe('book-c')
  expect(pages.source.getSnapshot().layout.activePaneId).toBe(focused)
  act(() => pages.focusTab(first))
  expect(view.getByLabelText('Book A')).toBe(input)
  expect(input).toHaveProperty('value', 'unsaved draft')
})
