/** Host React/UI only: no runtime TUI/React imports, timers, commands or filesystem access. */
import { anomalyLevel } from './attention.js'
import type { AttentionStore, AttentionSnapshot } from './attention.js'
import type { ActivitySnapshot, ActivityRow, ActivityStore } from './activity.js'

export type ActivityFilter = typeof ACTIVITY_FILTERS[number]
export interface ActivityViewOptions { filter?: ActivityFilter; page?: number; alert?: AttentionSnapshot }
export interface ActivityView {
  filter: ActivityFilter; page: number; pageCount: number; rowCount: number; lines: string[]
}
export interface PanelKeyEvent {
  input: string
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean; pageDown?: boolean; pageUp?: boolean }
  preventDefault(): void
}
export interface PanelHost {
  readonly focused: boolean
  snapshot(): { sessionId?: string; lang?: string }
  onKey(listener: (event: PanelKeyEvent) => void): () => void
}
/** The optional host supplies React and UI components; importing this module loads neither. */
export interface PanelReact<Node, Component> {
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T
  useState<T>(initial: T): [T, (value: T) => void]
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
  createElement(component: Component, props: Record<string, unknown>, ...children: (Node | string)[]): Node
}
export interface OpsPanelProps<Node = unknown, Component = unknown> {
  React: PanelReact<Node, Component>
  ui: { Box: Component; Text: Component }
  host: PanelHost
  width: number; height: number
}
interface Selection { sessionId?: string; filter: ActivityFilter; page: number }


export const ACTIVITY_FILTERS = Object.freeze(['all', 'running', 'anomalies'] as const)
const COPY = {
  en: { window: 'This session · since enabled', empty: 'No OPS calls observed yet', noSession: 'No active session',
    calls: 'Calls', running: 'Running', returned: 'Returned', errors: 'Tool errors', limited: 'Tracking limit reached; incomplete',
    neutral: 'Returned is not business success', alerts: 'All sessions · alerts', ack: 'a: ack all alerts',
    rejected: 'Rejected', unknown: 'Unknown effects', businessError: 'Operation errors', partial: 'Partial',
    omitted: 'Details omitted', more: 'Result has undisplayed details', inspect: 'Inspect effects; do not retry blindly', done: 'Done',
    filters: { all: 'All rows', running: 'Running', anomalies: 'Anomalies' }, kept: 'kept', noMatch: 'No retained rows in filter', cont: 'continued',
    keys: 'f filter · n/p page', ackKey: ' · a ack',
    status: { running: 'running', returned: 'returned', error: 'operation error', completed: 'completed', planned: 'preview/plan',
      rejected: 'rejected', partial: 'partial', unknown: 'unknown effects', unconfirmed: 'business unconfirmed' } },
  zh: { window: '当前会话 · 自启用后', empty: '尚未观察到 OPS 调用', noSession: '尚无活动会话',
    calls: '调用', running: '运行中', returned: '已返回', errors: '执行错误', limited: '观测达到上限，统计不完整',
    neutral: '已返回不代表操作成功', alerts: '所有会话 · 累计提醒', ack: 'a：确认所有提醒',
    rejected: '拒绝', unknown: '副作用未知', businessError: '业务失败', partial: '部分失败',
    omitted: '未展示明细', more: '结果含未展示明细', inspect: '请检查副作用，不要盲目重试', done: '完成',
    filters: { all: '全部记录', running: '运行中', anomalies: '异常记录' }, kept: '保留', noMatch: '此筛选中没有保留记录', cont: '续',
    keys: 'f 筛选 · n/p 翻页', ackKey: ' · a 确认',
    status: { running: '运行中', returned: '已返回', error: '业务/执行错误', completed: '完成', planned: '预览/计划',
      rejected: '拒绝', partial: '部分失败', unknown: '副作用未知', unconfirmed: '业务状态未确认' } },
}
type Copy = typeof COPY.en
const copyFor = (lang: string): Copy => COPY[lang.startsWith('zh') ? 'zh' : 'en']
const alertLines = (alert: AttentionSnapshot | undefined, text: Copy): string[] => alert?.unread ? [text.alerts + ' ' + alert.unread + (alert.capped ? '+' : '')] : []

function summaryLines(snapshot: ActivitySnapshot, text: Copy): string[] {
  const lines = [text.window], outcomes = snapshot.business
  if (snapshot.limited) lines.push(text.limited)
  if (outcomes.rejected || outcomes.unknown) lines.push(text.rejected + ' ' + outcomes.rejected + ' · ' + text.unknown + ' ' + outcomes.unknown)
  if (outcomes.error || outcomes.partial) lines.push(text.businessError + ' ' + outcomes.error + ' · ' + text.partial + ' ' + outcomes.partial)
  lines.push(text.calls + ' ' + snapshot.total + ' · ' + text.running + ' ' + snapshot.running,
    text.returned + ' ' + snapshot.returned + ' · ' + text.errors + ' ' + snapshot.errors)
  return lines
}
function rowLines(row: ActivityRow, text: Copy): string[] {
  if (row.status === 'running') return [row.name, '  ' + text.status.running]
  const outcome = row.status === 'error' && row.outcome !== 'unknown' ? 'error' : row.outcome ?? row.status
  const lines = [row.name, '  ' + text.status[outcome] + ' · ' + row.durationMs + ' ms']
  if (row.errorCode) lines.push('  ' + row.errorCode)
  if (row.outcome === 'unknown') lines.push('  ' + text.inspect)
  if (row.done !== undefined && row.total !== undefined) lines.push('  ' + text.done + ' ' + row.done + '/' + row.total)
  if ((row.omitted ?? 0) > 0) lines.push('  ' + text.omitted + ' ' + row.omitted)
  else if (row.complete === false) lines.push('  ' + text.more)
  return lines
}

/** Keep a record together when it fits; long diagnostics continue with their tool name. */
function paginate(rows: readonly ActivityRow[], capacity: number, text: Copy): string[][] {
  if (capacity < 1) return [[]]
  const pages: string[][] = []
  let current: string[] = []
  const flush = () => { if (current.length) pages.push(current); current = [] }
  for (const row of rows) {
    const lines = rowLines(row, text)
    if (lines.length <= capacity) {
      if (current.length + lines.length > capacity) flush()
      current.push(...lines)
      continue
    }
    flush()
    current = lines.slice(0, capacity)
    let offset = capacity
    while (offset < lines.length) {
      flush()
      const take = Math.max(1, capacity - 1)
      current = capacity > 1 ? [row.name + ' · ' + text.cont, ...lines.slice(offset, offset + take)]
        : [row.name + ': ' + lines[offset].trim()]
      offset += take
    }
  }
  flush()
  return pages.length ? pages : [[]]
}

/** Local pages of bounded retained metadata, never result pages or session-history reads. */
export function activityView(snapshot: ActivitySnapshot, lang = 'en', height = 24, options: ActivityViewOptions = {}): ActivityView {
  const text = copyFor(lang), size = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0
  const filter = options.filter !== undefined && ACTIVITY_FILTERS.includes(options.filter) ? options.filter : 'all'
  const rows = [...snapshot.active, ...snapshot.recent].filter(row => filter === 'all'
    || (filter === 'running' ? row.status === 'running' : anomalyLevel(row) !== undefined))
  const header = [...alertLines(options.alert, text), ...summaryLines(snapshot, text)]
  const capacity = Math.max(0, size - header.length - 3)
  const pages = paginate(rows, capacity, text), pageCount = pages.length
  const page = Math.max(0, Math.min(pageCount - 1, typeof options.page === 'number' && Number.isSafeInteger(options.page) ? options.page : 0))
  const body = rows.length ? pages[page] : [snapshot.total ? text.noMatch : text.empty].slice(0, capacity)
  const footer = [text.filters[filter] + ' · ' + (page + 1) + '/' + pageCount + ' · ' + text.kept + ' ' + rows.length,
    text.keys + (options.alert?.unread ? text.ackKey : ''), text.neutral]
  const padding = Array(Math.max(0, capacity - body.length)).fill('')
  return { filter, page, pageCount, rowCount: rows.length, lines: [...header, ...body, ...padding, ...footer].slice(0, size) }
}
export function activityLines(snapshot: ActivitySnapshot, lang = 'en', height = 24): string[] { return activityView(snapshot, lang, height).lines }

export function createOpsPanel(store: ActivityStore, attention: AttentionStore) {
  return function OpsPanel<Node, Component>({ React, ui, host, width, height }: OpsPanelProps<Node, Component>): Node {
    const context = host.snapshot(), sessionId = context.sessionId, lang = context.lang ?? 'en', text = copyFor(lang)
    const snapshot = React.useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId))
    const alert = React.useSyncExternalStore(attention.subscribe, attention.snapshot)
    const [selection, setSelection] = React.useState<Selection>({ sessionId, filter: 'all', page: 0 })
    const selected: Selection = selection.sessionId === sessionId ? selection : { filter: 'all', page: 0 }
    const view = activityView(snapshot, lang, height, { ...selected, alert })
    React.useEffect(() => {
      if (selection.sessionId !== sessionId) setSelection({ sessionId, filter: 'all', page: 0 })
      else if (selection.page !== view.page) setSelection({ ...selection, page: view.page })
    }, [sessionId, selection, view.page])
    React.useEffect(() => {
      if (!host.focused) return
      return host.onKey(event => {
        if (event.key.ctrl || event.key.meta || event.key.shift) return
        if (event.input === 'a') {
          if (attention.acknowledge()) event.preventDefault()
          return
        }
        if (!sessionId) return
        let { filter, page } = view
        if (event.input === 'f') { filter = ACTIVITY_FILTERS[(ACTIVITY_FILTERS.indexOf(filter) + 1) % ACTIVITY_FILTERS.length]; page = 0 }
        else if (event.input === 'n' || event.key.pageDown) page = Math.min(view.pageCount - 1, page + 1)
        else if (event.input === 'p' || event.key.pageUp) page = Math.max(0, page - 1)
        else return // Esc and panel-switch arrows belong to the host.
        setSelection({ sessionId, filter, page }); event.preventDefault()
      })
    }, [host, sessionId, view.filter, view.page, view.pageCount])
    const lines = sessionId ? view.lines : [...alertLines(alert, text), text.noSession, ...(alert.unread ? [text.ack] : [])].slice(0, Math.max(0, height))
    return React.createElement(ui.Box, { flexDirection: 'column', width, height, overflow: 'hidden' },
      ...lines.map((line, index) => React.createElement(ui.Text, { key: index, wrap: 'truncate-end' }, line)))
  }
}
