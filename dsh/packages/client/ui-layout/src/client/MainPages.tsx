import { useCallback, useMemo } from 'react'
import { DockLayout, dockPaneCount } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DockIntents, TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PageOptions, PagesSnapshot } from './pages.ts'
import type { pagesZh } from './page-locales.ts'
import css from './MainPages.module.css'

export interface PageLayoutInjected {
  readonly hooks: { readonly pages: HostObservable<PagesSnapshot> }
  readonly pageActions: DockIntents
  readonly updatePage: (id: TabId, options: PageOptions) => boolean
  readonly lockPage: (id: TabId, locked: boolean) => void
  readonly movePage: (id: TabId) => void
  readonly pageLabels: (key: keyof typeof pagesZh) => string
}

type Props = InjectFace<PageLayoutInjected> & PropsRenderSlots<'main'> & Pick<PropsRuntime<'root'>, 'useSessions'>
const retain = (): boolean => true

/** Retained bodies keep drafts and scroll positions when hidden or moved between columns. */
export function MainPages({ usePages, pageActions, updatePage, lockPage, movePage, pageLabels: t, renderSlot, useSessions }: Props) {
  const { layout, pages } = usePages(value => value)
  const sessions = useSessions(value => value.byId)
  const labels = useMemo(() => ({ emptyPane: t('empty'), splitPane: t('split'), splitPaneDisabled: t('full'), splitPaneNarrow: t('narrow'),
    closeTab: t('close'), addTab: t('add'), dockFloat: t('dock'), closeFloat: t('close'),
    dropZone: { left: t('left'), right: t('right'), top: t('top'), bottom: t('bottom'), center: t('center') },
  }), [t])
  const render = useCallback((tab: TabRecord) => {
    const page = pages[tab.id]!
    return <div className={css.page} data-lg-page={tab.id} onPointerDownCapture={() => pageActions.focusTab(tab.id)} onFocusCapture={() => pageActions.focusTab(tab.id)} data-global-panel={page.panelId !== null || undefined}>
      {renderSlot('main', { page, updatePage: options => updatePage(tab.id, options), lockPage: locked => lockPage(tab.id, locked), closePage: () => pageActions.closeTab(tab.id) }, { entryKey: page.panelId ?? 'conversation' })}
    </div>
  }, [pages, renderSlot, updatePage, lockPage, pageActions])
  const title = (tab: TabRecord) => {
    const page = pages[tab.id]!
    const sessionId = page.target.sessionId
    const text = page.panelId === null ? (typeof sessionId === 'string' ? sessions[sessionId as keyof typeof sessions]?.title : undefined) || t('conversation') : page.title
    return <span title={page.locked ? `${text} · ${t('locked')}` : text}>{page.locked ? '• ' : ''}{text}</span>
  }
  return <div className={css.workspace} data-lg-pages>
    <DockLayout state={layout} intents={pageActions} labels={labels} canSplit={dockPaneCount(layout) < 2}
      dropZones="horizontal" hideSplitWhenBlocked keepMounted={retain} renderTab={render} renderTabTitle={title}
      canCloseTab={id => !pages[id]?.locked} canAddTab={() => false}
      renderTabMenuItems={(tab, dismiss) => <button role="menuitem" onClick={() => { dismiss(); movePage(tab.id) }}>{t('move')}</button>}/>
  </div>
}
