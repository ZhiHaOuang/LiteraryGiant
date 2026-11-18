/** Page targets over the existing two-pane dock engine. No business data is copied here. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  applyOp, createIdMinter, createInitialState, findTabPane, getPane, dockPaneCount,
  planOpenContent, planPlaceTab, planResizeSplit, planSplitPane,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DockIntents, LayoutOp, LayoutState, PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { MainPanelId } from './service.ts'

/** A panel supplies its own stable entity key; versions belong in target, not identity. */
export interface PageOptions {
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

/** Props supplied to each independently retained main-panel occurrence. */
export interface PageOwnerProps {
  readonly page?: MainPage
  /** Update this tab's entity. False means an existing tab was revealed or this tab was locked. */
  readonly updatePage?: (options: PageOptions) => boolean
  /** Prevent closing or replacing unsaved work; switching tabs remains safe. */
  readonly closePage?: () => void
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
    const key = options.key ?? 'default'
    const existing = Object.values(this.snapshot.pages).find(page => page.panelId === panelId && page.key === key && ((options.scope ?? page.scope) === 'window' || findTabPane(this.snapshot.layout,page.id).id === this.snapshot.layout.activePaneId))
    if (existing !== undefined) {
      if (!existing.locked && options.target !== undefined) {
        this.update(existing.id, options)
      }
      this.commit([{ type: 'focusTab', tabId: existing.id }])
      return existing.id
    }
    const title = options.title ?? panelId ?? ''
    const planned = planOpenContent(this.snapshot.layout, this.mint.next, {
      kind: panelId ?? 'conversation', contentId: key, title, revealIfOpened: false,
    })
    this.commit(planned.ops, { ...this.snapshot.pages, [planned.tabId]: {
      id: planned.tabId, panelId, scope: options.scope ?? 'window', key, title, target: options.target ?? {}, locked: false,
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

  focusTab = (id: TabId): void => { if (this.active?.id !== id) this.commit([{ type: 'focusTab', tabId: id }]) }
  focusPane = (id: PaneId): void => { if (this.snapshot.layout.activePaneId !== id) this.commit([{ type: 'focusPane', paneId: id }]) }
  closeTab = (id: TabId): void => {
    if (this.snapshot.pages[id]?.locked) return
    const pages = { ...this.snapshot.pages }
    delete pages[id]
    this.commit([{ type: 'closeTab', tabId: id }], pages)
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
    placeTab: (id, paneId, index) => { this.commit(planPlaceTab(this.snapshot.layout, id, paneId, index)) },
    dropTab: (id, paneId, zone) => {
      if (dockPaneCount(this.snapshot.layout) === 1 && zone !== 'center') {
        this.split(paneId, zone === 'left' ? 'before' : 'after')
        const target = this.snapshot.layout.activePaneId
        this.commit(planPlaceTab(this.snapshot.layout, id, target, 0))
      } else {
        this.commit(planPlaceTab(this.snapshot.layout, id, paneId, getPane(this.snapshot.layout, paneId).tabs.length))
      }
    },
    resizeSplit: (id, sizes) => { this.commit(planResizeSplit(id, sizes)) },
    duplicateTab: id => { this.focusTab(id) },
    floatTab: id => { this.focusTab(id) },
    unfloatPane: () => {}, moveFloat: () => {}, resizeFloat: () => {},
  }

  moveToOtherPane(id: TabId): void {
    const current = findTabPane(this.snapshot.layout, id)
    if (dockPaneCount(this.snapshot.layout) === 1) this.intents.splitPane(current.id)
    const other = Object.values(this.snapshot.layout.nodes).find(node => node.kind === 'pane' && node.id !== current.id)
    if (other?.kind === 'pane') this.intents.placeTab(id, other.id, other.tabs.length)
  }
}
