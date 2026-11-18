import type { Translate } from './i18n'
import type { ContextSettings } from './settings'
import type { ClientCtx } from './services'
import { watchGate } from './toggleGate'

const FLEET_ORDER = 30

export function watchFleetTab(
  ctx: ClientCtx,
  settings: ContextSettings,
  view: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  return watchGate(
    settings.store,
    () => settings.fleetTab() === 'show',
    () => [ctx.slots.inject('conversation.view', () => ctx.slots.register(
      { name: 'conversation.view', id: 'fleet', order: FLEET_ORDER, locale: ns, label: () => t('tab.fleet') },
      view,
    ))],
  )
}
