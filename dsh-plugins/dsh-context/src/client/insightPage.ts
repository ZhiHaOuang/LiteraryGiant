import { createElement as h } from 'react'
import { InsightPanelIcon } from './icon'
import type { Translate } from './i18n'
import type { ContextSettings } from './settings'
import type { ClientCtx } from './services'
import { watchGate } from './toggleGate'

export const INSIGHT_PANEL_ID = 'dsh-context'

export const INSIGHT_PANEL_ORDER = 20

export function watchInsightPage(
  ctx: ClientCtx,
  settings: ContextSettings,
  page: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  return watchGate(
    settings.store,
    () => settings.insightsEntry() === 'show',
    () => [
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: INSIGHT_PANEL_ID, locale: ns },
        page,
      )),
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: INSIGHT_PANEL_ID, order: INSIGHT_PANEL_ORDER, label: () => t('ov.title'), locale: ns },
        props => h(InsightPanelIcon, { size: typeof props.size === 'number' ? props.size : undefined }),
      )),
    ],
  )
}
