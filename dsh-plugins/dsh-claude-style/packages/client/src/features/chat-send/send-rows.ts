import { SUBMISSION_ECHO_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { CHAT_ROW_SELECTOR, CHAT_USER_ROW_SELECTOR } from '@dsh-claude-style/engine/chat-dom'

/**
 * The rows a submission is recognised by, for both answers to how a sent
 * message arrives (constants.ts MESSAGE_ENTER_MODES): the flight
 * (send-flight.ts) and the growth (send-grow.ts) watch the same two moments,
 * so the row queries live beside the other chat reads (engine/chat-dom.ts)
 * rather than in either of them.
 */

/**
 * Take one echo row that has not been dealt with.
 *
 * Of a batch only the newest is taken (querySelectorAll is in document order)
 * and the rest are noted too, or they would be treated as new in later frames
 * and dealt with again.
 */
export function takeFreshEcho(handled: WeakSet<Element>) {
  const fresh: Element[] = []
  for (const echo of document.querySelectorAll(SUBMISSION_ECHO_SELECTOR)) {
    if (!handled.has(echo)) fresh.push(echo)
  }
  if (fresh.length === 0) return null
  for (const echo of fresh) handled.add(echo)
  const latest = fresh.at(-1)
  return latest instanceof HTMLElement ? latest : null
}

/** The row to take right now: the echo while it is there, and the real row once it has been swapped in. */
export function currentRow(previous: HTMLElement | null) {
  const echo = document.querySelector(SUBMISSION_ECHO_SELECTOR)
  if (echo instanceof HTMLElement && echo !== previous) return echo
  const row = lastUserRow()
  return row === previous ? null : row
}

export function lastUserRow() {
  const rows = document.querySelectorAll(CHAT_USER_ROW_SELECTOR)
  const last = rows.item(rows.length - 1)
  return last instanceof HTMLElement ? last : null
}

/**
 * Whether this batch of DOM changes touched a user row or an echo row.
 *
 * Only the added and removed nodes themselves are looked at: both marks sit on
 * the row element, and finding the row needs no subtree walk — on a long
 * session one walk is thousands of nodes.
 * @returns true when a row is worth recognising.
 */
export function touchesUserRow(records: MutationRecord[]) {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (isRowNode(node)) return true
    }
    for (const node of record.removedNodes) {
      if (isRowNode(node)) return true
    }
  }
  return false
}

/** Whether a node, or the subtree it brings, holds a user row or an echo row. */
export function isRowNode(node: Node) {
  return node instanceof HTMLElement
    && (node.matches(CHAT_ROW_SELECTOR) || node.querySelector(CHAT_ROW_SELECTOR) !== null)
}
