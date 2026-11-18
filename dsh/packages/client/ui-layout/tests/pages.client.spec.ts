import { describe, expect, it, vi } from 'vitest'
import { PageWorkspace } from '../src/client/pages.ts'
import type { MainPanelId } from '../src/client/service.ts'
import { dockPaneCount, findTabPane } from '@deepseek-ai/dsh-client-ui-dockkit'

const dashboard = 'dashboard' as MainPanelId
const editor = 'editor' as MainPanelId

describe('main page workspace', () => {
  it('keeps the global page while opening cross-book pages in the focused right pane', () => {
    const pages = new PageWorkspace(vi.fn())
    const global = pages.open(dashboard, { key: 'global' })
    const left = pages.source.getSnapshot().layout.activePaneId
    pages.intents.splitPane(left)
    const book = pages.open(dashboard, { key: '/books/b', target: { path: '/books/b' } })
    expect(dockPaneCount(pages.source.getSnapshot().layout)).toBe(2)
    expect(findTabPane(pages.source.getSnapshot().layout, global).id).toBe(left)
    expect(findTabPane(pages.source.getSnapshot().layout, book).id).not.toBe(left)
    pages.intents.splitPane(left)
    expect(dockPaneCount(pages.source.getSnapshot().layout)).toBe(2)
  })

  it('reveals an already open chapter across panes and updates its version in place', () => {
    const pages = new PageWorkspace(vi.fn())
    const chapter = pages.open(editor, { key: 'book-a:1', target: { version: 1 } })
    pages.intents.splitPane(pages.source.getSnapshot().layout.activePaneId)
    const again = pages.open(editor, { key: 'book-a:1', target: { version: 2 } })
    expect(again).toBe(chapter)
    expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(1)
    expect(pages.active?.target.version).toBe(2)
    expect(pages.open(editor, { key: 'book-b:1' })).not.toBe(chapter)
  })

  it('protects dirty work from close and target replacement but permits tab switching and moves', () => {
    const pages = new PageWorkspace(vi.fn())
    const chapter = pages.open(editor, { key: 'a:1', target: { version: 1 } })
    pages.lock(chapter, true)
    pages.closeTab(chapter)
    pages.open(editor, { key: 'a:1', target: { version: 2 } })
    expect(pages.active?.target.version).toBe(1)
    pages.moveToOtherPane(chapter)
    expect(pages.source.getSnapshot().pages[chapter]?.locked).toBe(true)
    pages.open(dashboard)
    expect(pages.active?.panelId).toBe(dashboard)
    pages.lock(chapter, false)
    pages.closeTab(chapter)
    expect(pages.source.getSnapshot().pages[chapter]).toBeUndefined()
  })

  it('prevents the chapter picker from claiming a chapter already owned by another tab', () => {
    const pages = new PageWorkspace(vi.fn())
    const a = pages.open(editor, { key: 'a:1' })
    const b = pages.open(editor, { key: 'a:2' })
    expect(pages.update(b, { key: 'a:1' })).toBe(false)
    expect(pages.active?.id).toBe(a)
    expect(pages.source.getSnapshot().pages[b]?.key).toBe('a:2')
  })
})

it('opens a Dashboard independently in the focused pane while reusing its local tab', () => {
  const pages = new PageWorkspace(vi.fn())
  const left = pages.open(dashboard, {key:'global',scope:'pane'})
  pages.intents.splitPane(pages.source.getSnapshot().layout.activePaneId)
  const right = pages.open(dashboard, {key:'global',scope:'pane'})
  expect(right).not.toBe(left)
  expect(pages.open(dashboard, {key:'global'})).toBe(right)
  expect(Object.keys(pages.source.getSnapshot().pages)).toHaveLength(2)
})

it('treats a left drop as a left split and does not navigate while resizing', () => {
  const selected = vi.fn()
  const pages = new PageWorkspace(selected)
  const first = pages.open(editor, { key: 'a:1' })
  const second = pages.open(editor, { key: 'b:1' })
  pages.intents.dropTab(second, pages.source.getSnapshot().layout.activePaneId, 'left')
  const {layout} = pages.source.getSnapshot()
  const root = layout.nodes[layout.rootId]!
  expect(root.kind).toBe('split')
  if (root.kind !== 'split') throw new Error('Expected a split')
  const left = layout.nodes[root.children[0]!]!
  const right = layout.nodes[root.children[1]!]!
  expect(left.kind === 'pane' && left.tabs).toContain(second)
  expect(right.kind === 'pane' && right.tabs).toContain(first)
  selected.mockClear()
  pages.intents.resizeSplit(root.id, [0.4, 0.6])
  expect(selected).not.toHaveBeenCalled()
})
