import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { DockLayout, findTabPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DockIntents, PaneId, PaneNode, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { Tooltip, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPage, PageOptions, PagesSnapshot } from './pages.ts'
import type { pagesZh } from './page-locales.ts'
import css from './MainPages.module.css'

export interface PageLayoutInjected {
  readonly hooks: { readonly pages: HostObservable<PagesSnapshot> }
  readonly pageActions: DockIntents
  readonly updatePage: (id: TabId, options: PageOptions) => boolean
  readonly lockPage: (id: TabId, locked: boolean) => void
  readonly closePane: (id: PaneId) => void
  readonly pageLabels: (key: keyof typeof pagesZh) => string
}

type Props = InjectFace<PageLayoutInjected> & PropsRenderSlots<'main'> & Pick<PropsRuntime<'root'>, 'useSessions'>
const retain = (): boolean => true

function HeaderActions({ id, register }: { id: TabId; register: (id: TabId, node: HTMLDivElement | null) => void }) {
  const ref = useCallback((node: HTMLDivElement | null) => register(id, node), [id, register])
  return <div ref={ref} className={css.actions} data-lg-header-actions/>
}

/** Native dock retention keeps the surviving column stable when its sibling closes. */
export function MainPages({ usePages, pageActions, updatePage, lockPage, closePane, pageLabels: t, renderSlot, useSessions }: Props) {
  const { layout, pages } = usePages(value => value)
  const sessions = useSessions(value => value.byId)
  const [actionHosts, setActionHosts] = useState<Readonly<Partial<Record<TabId, HTMLDivElement>>>>({})
  const registerActions = useCallback((id: TabId, node: HTMLDivElement | null) => {
    setActionHosts(previous => {
      if (previous[id] === (node ?? undefined)) return previous
      const next = { ...previous }
      if (node === null) delete next[id]
      else next[id] = node
      return next
    })
  }, [])
  const labels = useMemo(() => ({ emptyPane: t('empty'), splitPane: t('split'), splitPaneDisabled: t('full'), splitPaneNarrow: t('narrow'),
    closeTab: t('close'), addTab: t('add'), dockFloat: t('dock'), closeFloat: t('close'),
    dropZone: { left: t('left'), right: t('right'), top: t('top'), bottom: t('bottom'), center: t('center') },
  }), [t])
  const title = (page: MainPage): string => {
    const sessionId = page.target.sessionId
    return page.panelId === null ? (typeof sessionId === 'string' ? sessions[sessionId as keyof typeof sessions]?.title : undefined) || t('conversation') : page.title
  }
  const chrome = (pane: PaneNode) => {
    return {
      actions: (children: ReactNode) => {
        const host = pane.activeTabId === undefined ? undefined : actionHosts[pane.activeTabId]
        return host === undefined ? null : createPortal(children, host)
      },

    }
  }
  const render = (tab: TabRecord) => {
    const page = pages[tab.id]!
    return <div className={css.page} data-lg-page={tab.id} onPointerDownCapture={() => pageActions.focusTab(tab.id)} onFocusCapture={() => pageActions.focusTab(tab.id)} data-global-panel={page.panelId !== null || undefined}>
      {renderSlot('main', { page, pageChrome: chrome({ ...findTabPane(layout, tab.id), activeTabId: tab.id }), updatePage: options => updatePage(tab.id, options), lockPage: locked => lockPage(tab.id, locked), closePage: () => pageActions.closeTab(tab.id) }, { entryKey: page.panelId ?? 'conversation' })}
    </div>
  }
  return <div className={css.workspace} data-lg-pages>
    <DockLayout state={layout} intents={pageActions} labels={labels} canSplit={false}
      dropZones="horizontal" hideSplitWhenBlocked keepMounted={retain} renderTab={render}
      canCloseTab={id => !pages[id]?.locked} canAddTab={() => false}
      renderPaneHeader={pane => {
        const page = pane.activeTabId === undefined ? undefined : pages[pane.activeTabId]
        return <header className={css.header} data-window-drag data-lg-pane-header
          onPointerDownCapture={() => pageActions.focusPane(pane.id)}>
          <span className={css.title} data-lg-page-title title={page?.locked ? t('locked') : page === undefined ? undefined : title(page)}>
            {page === undefined ? 'LiteraryGiant' : `${page.locked ? '• ' : ''}${title(page)}`}
          </span>
          <div className={css.dragSpace}/>
          {pane.activeTabId !== undefined && <HeaderActions id={pane.activeTabId} register={registerActions}/>}
          <Tooltip label={page?.locked ? t('locked') : t('close')} portal>
            <button className={css.close} aria-label={t('close')} disabled={page?.locked || pane.activeTabId === undefined}
              onClick={event => { event.stopPropagation(); closePane(pane.id) }}><IconCloseOutlineRegular size={16}/></button>
          </Tooltip>
        </header>
      }}/>
  </div>
}
