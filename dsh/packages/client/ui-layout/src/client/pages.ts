/** Page targets over the existing two-pane dock engine. No business data is copied here. */
import type { ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  applyOp, createIdMinter, createInitialState, findTabPane, getPane, dockPaneCount,
  planOpenContent, planResizeSplit, planSplitPane,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DockIntents, LayoutOp, LayoutState, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { MainPanelId } from './service.ts'

/** A panel supplies its own stable entity key; versions belong in target, not identity. */
export interface PageOptions {
  /** Open in the other column, creating it only when needed. Not persisted as page identity. */
  readonly placement?: 'split' | undefined
  readonly scope?: 'pane' | 'window'
  readonly key?: string
  readonly title?: string
  readonly target?: Readonly<Record<string, unknown>>
}

export interface MainPage {
  readonly id: TabId
  readonly panelId: MainPanelId | null
  readonly scope: 'pane' | 'window'
  readonly key: string
  readonly title: string
  readonly target: Readonly<Record<string, unknown>>
  readonly locked: boolean
}

export interface PagesSnapshot {
  readonly layout: LayoutState
  readonly pages: Readonly<Record<TabId, MainPage>>
}

/** Controls supplied by the current page to its shared title row. */
export interface PageChrome {
  /** Render business-owned controls into this page’s common title row. */
  readonly actions?: (children: ReactNode) => ReactNode
}

export interface PageOwnerProps {
  readonly pageChrome?: PageChrome | undefined
  readonly page?: MainPage
  /** Update this tab's entity. False means an existing tab was revealed or this tab was locked. */
  readonly updatePage?: (options: PageOptions) => boolean
  /** Close the current page without deleting its underlying book or Session. */
  readonly closePage?: () => void
  /** Prevent closing or replacing unsaved work. */
  readonly lockPage?: (locked: boolean) => void
}

export class PageWorkspace {
  private readonly mint = createIdMinter()
  readonly source = createSnapshotStore<PagesSnapshot>({ layout: { ...createInitialState(this.mint), expanded: true }, pages: {} })

  constructor(private readonly onSelect: (page: MainPage | undefined) => void) {}

  private get snapshot(): PagesSnapshot { return this.source.getSnapshot() }
  get active(): MainPage | undefined {
    const id = getPane(this.snapshot.layout, this.snapshot.layout.activePaneId).activeTabId
    return id === undefined ? undefined : this.snapshot.pages[id]
  }

  private commit(ops: readonly LayoutOp[], pages = this.snapshot.pages): void {
    const previousTab = this.active?.id
    const previousPane = this.snapshot.layout.activePaneId
    let layout = this.snapshot.layout
    for (const op of ops) layout = applyOp(layout, op).state
    this.source.set({ layout, pages })
    if (this.active?.id !== previousTab || layout.activePaneId !== previousPane) this.onSelect(this.active)
  }

  open(panelId: MainPanelId | null, options: PageOptions = {}): TabId {
    let layout = this.snapshot.layout
    const ops: LayoutOp[] = []
    if (options.placement === 'split') {
      let other = Object.values(layout.nodes).find(node => node.kind === 'pane' && node.id !== layout.activePaneId)
      if (other === undefined) {
        const splitOps = planSplitPane(layout, this.mint.next, layout.activePaneId)
        ops.push(...splitOps)
        for (const op of splitOps) layout = applyOp(layout, op).state
        other = Object.values(layout.nodes).find(node => node.kind === 'pane' && node.id !== layout.activePaneId)
      }
      if (other !== undefined) {
        const focus: LayoutOp = { type: 'focusPane', paneId: other.id as PaneId }
        ops.push(focus)
        layout = applyOp(layout, focus).state
      }
    }
    const key = options.key ?? 'default'
    const scope = options.scope ?? Object.values(this.snapshot.pages).find(page => page.panelId === panelId && page.key === key)?.scope ?? 'window'
    const matching = Object.values(this.snapshot.pages).filter(page => page.panelId === panelId && page.key === key)
    // A pane-local page wins over an older matching global launcher in the other column.
    const existing = matching.find(page => findTabPane(layout, page.id).id === layout.activePaneId)
      ?? matching.find(page => (options.scope ?? page.scope) === 'window')
    if (existing !== undefined) {
      if (!existing.locked && options.target !== undefined) {
        this.update(existing.id, options)
      }
      this.commit([{ type: 'focusTab', tabId: existing.id }])
      return existing.id
    }
    const previous = getPane(layout, layout.activePaneId).activeTabId
    if (previous !== undefined && this.snapshot.pages[previous]?.locked) {
      this.focusTab(previous)
      return previous
    }
    const pages = { ...this.snapshot.pages }
    if (previous !== undefined) {
      const close: LayoutOp = { type: 'closeTab', tabId: previous }
      ops.push(close)
      layout = applyOp(layout, close).state
      delete pages[previous]
    }
    const title = options.title ?? panelId ?? ''
    const planned = planOpenContent(layout, this.mint.next, {
      kind: panelId ?? 'conversation', contentId: key, title, revealIfOpened: false,
    })
    this.commit([...ops, ...planned.ops], { ...pages, [planned.tabId]: {
      id: planned.tabId, panelId, scope, key, title, target: options.target ?? {}, locked: false,
    } })
    return planned.tabId
  }

  update(id: TabId, options: PageOptions): boolean {
    const page = this.snapshot.pages[id]
    if (page === undefined || page.locked) return false
    const key = options.key ?? page.key
    const existing = Object.values(this.snapshot.pages).find(other => other.id !== id && other.panelId === page.panelId && other.key === key && (page.scope === 'window' || findTabPane(this.snapshot.layout,other.id).id === findTabPane(this.snapshot.layout,id).id))
    if (existing !== undefined) {
      this.focusTab(existing.id)
      return false
    }
    const updated = { ...page, key, title: options.title ?? page.title, target: options.target ?? page.target }
    const layout = this.snapshot.layout
    const tab = layout.tabs[id]!
    this.source.set({ layout: { ...layout, tabs: { ...layout.tabs, [id]: { ...tab, contentId: key, title: updated.title } } },
      pages: { ...this.snapshot.pages, [id]: updated } })
    return true
  }

  lock(id: TabId, locked: boolean): void {
    const page = this.snapshot.pages[id]
    if (page === undefined || page.locked === locked) return
    this.source.set({ ...this.snapshot, pages: { ...this.snapshot.pages, [id]: { ...page, locked } } })
  }

  focusTab = (id: TabId): void => { if (this.snapshot.pages[id] !== undefined && this.active?.id !== id) this.commit([{ type: 'focusTab', tabId: id }]) }
  focusPane = (id: PaneId): void => { if (this.snapshot.layout.nodes[id]?.kind === 'pane' && this.snapshot.layout.activePaneId !== id) this.commit([{ type: 'focusPane', paneId: id }]) }
  closeTab = (id: TabId): void => {
    const page = this.snapshot.pages[id]
    if (page === undefined || page.locked) return
    const pane = findTabPane(this.snapshot.layout, id)
    const pages = { ...this.snapshot.pages }
    delete pages[id]
    const ops: LayoutOp[] = [{ type: 'closeTab', tabId: id }]
    if (pane.tabs.length === 1 && dockPaneCount(this.snapshot.layout) > 1) ops.push({ type: 'merge', paneId: pane.id })
    this.commit(ops, pages)
  }
  /** Each column has one current page; the dock engine expands its surviving sibling. */
  closePane = (paneId: PaneId): void => {
    const pane = this.snapshot.layout.nodes[paneId]
    if (pane?.kind !== 'pane') return
    if (pane.activeTabId !== undefined) this.closeTab(pane.activeTabId)
    else if (dockPaneCount(this.snapshot.layout) > 1) this.commit([{ type: 'merge', paneId }])
  }

  retainPanels(panelIds: readonly string[]): void {
    for (const page of Object.values(this.snapshot.pages)) {
      if (page.panelId !== null && !panelIds.includes(page.panelId)) {
        this.lock(page.id, false)
        this.closeTab(page.id)
      }
    }
  }

  private split(paneId: PaneId, direction: 'before' | 'after' = 'after'): void {
    if (dockPaneCount(this.snapshot.layout) >= 2) return
    const ops = planSplitPane(this.snapshot.layout, this.mint.next, paneId).map(op => op.type === 'split' ? { ...op, direction } : op)
    const split = ops.find(op => op.type === 'split')
    if (split?.type === 'split') this.commit([...ops, { type: 'focusPane', paneId: split.newPaneId }])
  }

  /** The first version deliberately exposes only two horizontal panes, with no floating or copies. */
  readonly intents: DockIntents = {
    focusTab: this.focusTab,
    focusPane: this.focusPane,
    closeTab: this.closeTab,
    splitPane: paneId => { this.split(paneId) },
    addTab: paneId => { this.focusPane(paneId) },
    placeTab: id => { this.focusTab(id) },
    dropTab: id => { this.focusTab(id) },
    resizeSplit: (id, sizes) => { this.commit(planResizeSplit(id, sizes)) },
    duplicateTab: id => { this.focusTab(id) },
    floatTab: id => { this.focusTab(id) },
    unfloatPane: () => {}, moveFloat: () => {}, resizeFloat: () => {},
  }

}
