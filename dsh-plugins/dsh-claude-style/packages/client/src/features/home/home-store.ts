import { USAGE_ROUTE } from '../../constants'
import { pad2 } from '../../shared/format'
import { notifyAll } from '@dsh-claude-style/engine/notify'
import { hostRemoteSession } from '@dsh-claude-style/engine/host'
import type { HostContext } from '@dsh-claude-style/engine/host'
import type { HostRemoteListAnswer, HostSessionRow } from '@dsh-claude-style/contracts/services'
import type { UsageAnswer, UsageReport } from '@dsh-claude-style/contracts/usage'
import { homeRefreshDue } from './usage-refresh'
import type { HomeRefreshReason } from './usage-refresh'

/**
 * The roll-up store's snapshot: the route's last answer (the host half's
 * usage fold, packages/host/src/usage-fold.ts), whether more is coming, and why not.
 */
export interface HomeUsageState {
  value: UsageReport | null
  computing: boolean
  error: string | null
  loading: boolean
  /** When this page last heard from the route, on the page's clock; null before the first answer. */
  answeredAt: number | null
}

/** One model's share in the session list's roll-up. */
export interface ListedModel {
  id: string
  tokens: number
  sessions: number
  lastAt: number
}

/** The session list's roll-up (summarizeSessionList). */
export interface ListSummary {
  tokens: number
  sessions: number
  activeDays: number
  model: string | null
  models: ListedModel[]
  days: { date: string, total: number }[]
  entries: { at: number, tokens: number, model: string | null }[]
}

/** Where the roll-up lands while the host half is still folding. */
export const HOME_POLL_MS = 800
/**
 * Polls in a row a cold fold may go unanswered before the panel settles on what
 * it has: the fold reads every changed session log, and a large history on a
 * slow disk takes minutes, so the panel stops waiting long after the first
 * numbers could have arrived. The next read starts over once they do.
 */
export const HOME_POLL_MAX = 180

/** A local calendar day, matching the host half's day keys. */
export function homeDayKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * The roll-up store: the route's answer, the list's answer, and the reads that
 * keep the first one current.
 *
 * The route (`USAGE_ROUTE`) is the panel's first source: it folds the local
 * session logs (or reads the cost-meter ledger) and answers immediately with
 * whatever it already knows. A cold answer carries `computing`, and the panel
 * keeps its skeleton up and polls until the value lands — so the first paint
 * never waits on the aggregation, and a value that has not arrived yet is
 * never drawn as a zero.
 *
 * The session list is the second source. Every listed session carries the
 * host's token-usage and model-selection projections, so it answers even when
 * the route cannot (an older host half, or a failed fold). It is coarser —
 * one total per session, bucketed onto that session's last-activity day — so
 * the panel names the source it drew from.
 *
 * @returns accessors, the loads, and a stop that ends the reads and listeners.
 */
export function createHomeUsage(ctx: HostContext) {
  /** What the panel draws: the last answer, whether more is coming, and why not. */
  const usage: HomeUsageState = { value: null, computing: false, error: null, loading: false, answeredAt: null }
  let listSummary: ListSummary | null = null
  let listLoading = false
  const listeners: (() => void)[] = []
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /** Polls this read has made; reset by each ask (loadUsage). */
  let polls = 0
  let disposed = false

  function emit() {
    notifyAll(listeners)
  }

  function subscribe(listener: () => void) {
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index !== -1) listeners.splice(index, 1)
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  /**
   * One read of the roll-up. The answer's `computing` schedules the next poll,
   * so the panel fills in as soon as the host half has the numbers; a read whose
   * polls run out leaves the panel on what it has, and the next ask starts the
   * count over.
   *
   * @param force - read even though numbers are on show and nothing is folding.
   */
  function loadUsage(force?: boolean) {
    if (disposed || usage.loading) return
    if (!force && usage.value !== null && !usage.computing) return
    // Each ask is its own count: a fold behind a cold start may take minutes,
    // and a limit carried across asks would spend the whole budget on the first.
    polls = 0
    read()
  }

  /** One request to the route, and the poll its answer asks for while the host half is folding. */
  function read() {
    usage.loading = true
    const request = fetch(USAGE_ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    request.then(response => response !== null && response.ok === true ? response.json() : null).then((body: UsageAnswer | null) => {
      usage.loading = false
      if (disposed) return
      // A route that refused still answered: the next ask waits out the same
      // period instead of retrying on every pass.
      usage.answeredAt = Date.now()
      if (body === null || body.ok !== true) {
        usage.error = 'unavailable'
        emit()
        return
      }
      usage.value = body.value === undefined ? null : body.value
      usage.computing = body.computing === true
      usage.error = body.error === undefined ? null : body.error
      emit()
      if (usage.computing) {
        if (polls >= HOME_POLL_MAX) return
        polls += 1
        stopPolling()
        pollTimer = setTimeout(() => {
          pollTimer = null
          read()
        }, HOME_POLL_MS)
      }
    // A failed usage fetch is the panel's "unavailable" state, not an exception: the panel renders without the numbers (D12).
    }).catch(() => {
      usage.loading = false
      if (disposed) return
      usage.answeredAt = Date.now()
      usage.error = 'unavailable'
      emit()
    })
  }

  /**
   * Read the roll-up again if the numbers on show have aged past the wake or
   * the period (usage-refresh.ts), and answer whether this page asked.
   *
   * A read of this page's own counts as in flight while it crosses or while it
   * has a poll pending: that poll is what carries the numbers in. A read whose
   * polls have run out leaves nothing pending, so the next period asks again
   * rather than the panel going quiet for good.
   *
   * @param reason - `'tick'` for a panel standing on the page, `'wake'` for one the reader came back to.
   */
  function refreshUsage(reason: HomeRefreshReason) {
    if (disposed) return false
    const due = homeRefreshDue(Date.now(), { answeredAt: usage.answeredAt, busy: usage.loading || pollTimer !== null }, reason)
    if (!due) return false
    loadUsage(true)
    return true
  }

  /**
   * The session list's roll-up.
   *
   * The host's list rows carry their own projection block
   * (`projections.values`): `tokenUsage` with its four disjoint buckets,
   * `modelSelection` with the route the session last used, and
   * `sessionListMetadata` with the blank flag and the last prompt time.
   * Summing them gives the panel a second, cheaper source — and the model
   * list's fallback when the roll-up route cannot answer.
   *
   * A session's whole total is bucketed onto its own last-activity day: the
   * list has no per-day split, so this is coarser than the host half's fold,
   * which is exactly why the panel names the source it drew from.
   */
  function summarizeSessionList(rows: HostSessionRow[]): ListSummary {
    let tokens = 0
    const dayCount: Record<string, boolean> = {}
    const byDay: Record<string, number> = {}
    const byModel: Record<string, { tokens: number, sessions: number, lastAt: number }> = {}
    const entries: ListSummary['entries'] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const values = row !== null && row !== undefined && row.projections !== undefined && row.projections !== null
        ? row.projections.values
        : null
      if (values === null || values === undefined) continue
      const meta = values.sessionListMetadata
      if (meta !== null && meta !== undefined && meta.blank === true) continue
      const bucket = values.tokenUsage
      const total = bucket === null || bucket === undefined ? 0
        : (bucket.uncachedInputTokens || 0) + (bucket.outputTokens || 0)
          + (bucket.cacheReadTokens || 0) + (bucket.cacheWriteTokens || 0)
      tokens += total
      const at = meta !== null && meta !== undefined && typeof meta.lastPromptAt === 'number'
        ? meta.lastPromptAt
        : row.updatedAt
      const selection = values.modelSelection
      const picked = selection !== null && selection !== undefined ? (selection.next || selection.lastUsed) : null
      const id = picked !== null && picked !== undefined && typeof picked.model === 'string' ? picked.model : null
      entries.push({ at: typeof at === 'number' ? at : 0, tokens: total, model: id })
      if (typeof at === 'number') {
        const day = homeDayKey(new Date(at))
        dayCount[day] = true
        byDay[day] = (byDay[day] || 0) + total
      }
      if (id !== null) {
        let cell = byModel[id]
        if (cell === undefined) {
          cell = { tokens: 0, sessions: 0, lastAt: 0 }
          byModel[id] = cell
        }
        cell.tokens += total
        cell.sessions += 1
        if (typeof at === 'number' && at > cell.lastAt) cell.lastAt = at
      }
    }
    let favorite: string | null = null
    let best = 0
    const models: ListedModel[] = []
    for (const name in byModel) {
      models.push({ id: name, tokens: byModel[name].tokens, sessions: byModel[name].sessions, lastAt: byModel[name].lastAt })
      if (byModel[name].sessions > best) {
        best = byModel[name].sessions
        favorite = name
      }
    }
    models.sort((left, right) => right.tokens - left.tokens)
    const days: ListSummary['days'] = []
    for (const date in byDay) days.push({ date, total: byDay[date] })
    return { tokens, sessions: entries.length, activeDays: Object.keys(dayCount).length, model: favorite, models, days, entries }
  }

  /** Read the session list once; a host without the remote service keeps the route's answer. */
  function loadSessionSummary() {
    if (disposed || listLoading || listSummary !== null) return
    const sessions = hostRemoteSession(ctx)
    if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return
    listLoading = true
    sessions.list({}).then((result: HostRemoteListAnswer) => {
      listLoading = false
      if (disposed) return
      const items = result !== null && result !== undefined && result.ok === true
        && result.value !== null && result.value !== undefined && Array.isArray(result.value.items)
        ? result.value.items
        : null
      if (items === null) return
      listSummary = summarizeSessionList(items)
      emit()
    // The roll-up is a summary the panel can do without: a failed fetch just ends the loading mark (D12).
    }).catch(() => {
      listLoading = false
    })
  }

  return {
    state() { return usage },
    list() { return listSummary },
    listLoading() { return listLoading },
    subscribe,
    /** Ask every view to re-render; a state change outside the store uses it. */
    notify: emit,
    load: loadUsage,
    refresh: refreshUsage,
    loadList: loadSessionSummary,
    stop() {
      disposed = true
      stopPolling()
      listeners.length = 0
    },
  }
}
