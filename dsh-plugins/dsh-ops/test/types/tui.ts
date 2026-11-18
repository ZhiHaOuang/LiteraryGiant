import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BusinessOutcome } from '../../src/tui/result.js'
import type { ActivityRow, ActivitySnapshot } from '../../src/tui/activity.js'
import type { OpsPanelProps, PanelKeyEvent } from '../../src/tui/panel.js'
import { createActivityStore, resolveActivityConfig } from '../../src/tui/activity.js'
import { createAttentionStore } from '../../src/tui/attention.js'
import { resultDetails } from '../../src/tui/result.js'
import { activityView, createOpsPanel } from '../../src/tui/panel.js'
import { renderPanelHtml } from '../../src/panel/render.js'

declare const event: SessionEvent
const config = resolveActivityConfig({ recentLimit: 4 })
const store = createActivityStore(config), attention = createAttentionStore()
const accepted: boolean = store.observe('session', event)
const snapshot: ActivitySnapshot = store.snapshot('session')
const outcome: BusinessOutcome = resultDetails('tool', null, false).outcome
const unsubscribe: () => void = store.subscribe(() => {})
const html: string = renderPanelHtml()
// @ts-expect-error Retention settings must be numeric, even though raw config parsing accepts unknown.
void createActivityStore({ maxSessions: '32' })
// @ts-expect-error An immutable snapshot cannot modify observer counters.
snapshot.total++
// @ts-expect-error Business counters are immutable as well.
snapshot.business.completed = 0
// @ts-expect-error Caller code cannot append retained rows.
snapshot.recent.push(snapshot.recent[0])
// @ts-expect-error Raw arguments are not part of retained metadata.
void snapshot.recent[0].arguments
// @ts-expect-error Raw content is not part of retained metadata.
void snapshot.recent[0].content
// @ts-expect-error Attention is acknowledged through the store, not by rewriting a snapshot.
attention.snapshot().unread = 0
// @ts-expect-error The typed renderer only selects declared activity filters.
void activityView(snapshot, 'en', 24, { filter: 'partial' })
declare const row: ActivityRow
if (row.status === 'running') {
  // @ts-expect-error A running call has no settled duration.
  void row.durationMs
  // @ts-expect-error A running call cannot claim business completion.
  void row.outcome
} else {
  const duration: number = row.durationMs
  const settled: BusinessOutcome = row.outcome
  void [duration, settled]
}
type Rendered = { readonly rendered: true }
declare const props: OpsPanelProps<Rendered, 'box' | 'text'>
const panel = createOpsPanel(store, attention)
const element: Rendered = panel(props)
// @ts-expect-error The renderer's size comes from numeric host dimensions.
void panel({ ...props, width: '28' })
// @ts-expect-error The return node preserves the injected renderer's type.
const invalid: boolean = panel(props)
props.React.useSyncExternalStore(store.subscribe, () => store.snapshot())
props.host.onKey((key: PanelKeyEvent) => { if (key.input === 'n') key.preventDefault() })
void [accepted, outcome, unsubscribe, html, element, invalid]
