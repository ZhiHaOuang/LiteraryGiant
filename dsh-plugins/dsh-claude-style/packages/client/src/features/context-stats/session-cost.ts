import { PRICES_PATH, SESSION_COST_PATH } from '@dsh-claude-style/contracts/routes'
import type { PriceDocument, SessionCostAnswer } from '@dsh-claude-style/contracts/prices'
import { billingRowEntry, parseBillingTable } from '@dsh-claude-style/contracts/billing-table'
import type { BillingRow } from '@dsh-claude-style/contracts/billing-table'

/**
 * The price table and the current session's settled cost, both from the host
 * half over its own routes.
 *
 * The browser cannot price a settlement on its own: the log and the table live
 * on the host. So it asks for the table once a day and for the session's
 * settled total whenever the usage projection moves (a settlement), throttled
 * so a stream of projection frames cannot become a poll. The estimate for the
 * answer still streaming is added on top by the caller, from the same character
 * count the written-back token figure rides (stream-estimate.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** The shortest gap between two asks about one session. */
const ASK_MS = 1500

/** The reader's own rows, and the currency they answer in, as the page last sent them. */
let billing: { rows: readonly BillingRow[], currency: string | null } = { rows: [], currency: null }

let document: PriceDocument | null = null
let fetchedAt = 0
let fetching: Promise<void> | null = null
/** Bumped when the document changes, so a page that adopted one keeps it. */
let generation = 0

/** Adopt the reader's rows from the preferences; the answer to hand back is whether they moved. */
export function adoptBillingRows(entries: readonly string[], currency: string | null) {
  const rows = parseBillingTable(entries)
  const same = rows.length === billing.rows.length
    && rows.every((row, i) => entryOf(row) === entryOf(billing.rows[i]))
  billing = { rows, currency }
  return !same
}

/** One row written back as its stored entry, for comparing what stands. */
export function entryOf(row: BillingRow) {
  return billingRowEntry(row.model, String(row.cacheMiss ?? ''), String(row.cacheHit ?? ''), String(row.output ?? ''))
}

/** The reader's rows in force, for a caller that prices without asking the host. */
export function billingRows() {
  return billing.rows
}

/** The query the host needs to price with the reader's rows. */
function billingQuery() {
  const parts: string[] = []
  if (billing.currency !== null) parts.push(`cur=${encodeURIComponent(billing.currency)}`)
  for (const row of billing.rows) parts.push(`b=${encodeURIComponent(entryOf(row))}`)
  return parts.length === 0 ? '' : `&${parts.join('&')}`
}

/** The table in force, or null until the host answers. */
export function priceDocument() {
  return document
}

/** One generation count the tick can compare, so a new table re-renders. */
export function priceGeneration() {
  return generation
}

/** Ask the host for its table; a fetch in flight is shared and one a day is enough. */
export function loadPrices(now: number): Promise<void> {
  if (fetching !== null) return fetching
  if (document !== null && now - fetchedAt < DAY_MS) return Promise.resolve()
  fetching = fetch(PRICES_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(response => (response.ok ? response.json() : null))
    .then((body: { ok?: boolean, document?: PriceDocument, fetchedAt?: string } | null) => {
      if (body !== null && body.ok === true && body.document !== undefined && body.document !== null) {
        document = body.document
        fetchedAt = typeof body.fetchedAt === 'string' ? Date.parse(body.fetchedAt) : now
        generation += 1
      }
    })
    .catch(() => {
      // A failed fetch keeps the table already held; the shipped copy answered
      // first if this page never got one (D12's isolation).
    })
    .finally(() => {
      fetching = null
    })
  return fetching
}

/** One session's settled cost, followed across a session switch. */
export function createSessionCost() {
  let sessionId = ''
  let answer: SessionCostAnswer | null = null
  let askedAt = 0
  let asking = false
  /** Bumped when the followed session changes and when an ask starts; a settle from another generation is dropped. */
  let askGeneration = 0
  const listeners = new Set<() => void>()

  /** Follow the conversation on screen; a switch drops the previous session's answer. */
  function follow(id: string) {
    if (id === sessionId) return
    sessionId = id
    answer = null
    askedAt = 0
    // The ask in flight belongs to the session left behind. Its answer is not
    // this session's, and the flag it settles must not stand in the way of the
    // ask this session still needs.
    asking = false
    askGeneration += 1
  }

  /**
   * Ask for the settled total, at most once per `ASK_MS`.
   *
   * The total moves on every settlement, so an answer already in hand never
   * makes a later ask unnecessary; the interval alone is what keeps the passes
   * from becoming a poll.
   *
   * @param now - the pass's instant.
   * @param force - ask even inside the interval (a new price table).
   */
  function ask(now: number, force = false) {
    if (sessionId === '' || asking) return
    if (!force && askedAt !== 0 && now - askedAt < ASK_MS) return
    askedAt = now
    asking = true
    const generation = ++askGeneration
    fetch(`${SESSION_COST_PATH}?id=${encodeURIComponent(sessionId)}${billingQuery()}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(response => (response.ok ? response.json() : null))
      .then((body: { ok?: boolean, value?: SessionCostAnswer | null } | null) => {
        if (generation !== askGeneration) return
        if (body !== null && body.ok === true && body.value !== undefined && body.value !== null) {
          answer = body.value
          for (const listener of listeners) listener()
        }
      })
      .catch(() => {
        // The last answer stays; the next settlement tries again.
      })
      .finally(() => {
        if (generation !== askGeneration) return
        asking = false
        // A session the store has not folded yet answers an empty total; the
        // first settlement arrives a moment after the turn starts, so the next
        // pass asks again rather than keeping the placeholder.
        if (answer !== null && answer.cny === 0 && answer.usd === 0 && answer.model === null) askedAt = 0
      })
  }

  return {
    follow,
    ask,
    /** The settled totals in both currencies, or null before the first answer. */
    value() {
      return answer
    },
    /** Tell the caller a new total landed, so the line can be written again. */
    onChange(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
