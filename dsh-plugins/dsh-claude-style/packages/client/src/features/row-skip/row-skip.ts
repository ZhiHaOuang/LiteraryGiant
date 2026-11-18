import { FLOW_KIND_ATTRIBUTE } from '@dsh-claude-style/contracts/dom'
import { observeMatches, observeSize, subscribeMutations } from '@dsh-claude-style/engine/bus'
import { conversationScroller } from '@dsh-claude-style/engine/chat-dom'
import { requestFrame } from '@dsh-claude-style/engine/frame'

/**
 * Which of the conversation's rows the stylesheet may skip (row-skip.css).
 *
 * A row arriving is laid out at its real size by the frame that follows, and
 * `contain-intrinsic-size: auto` remembers that height; the mark goes on the
 * frame after, and only then may the row be skipped, standing at the height it
 * really has. A change of the column's width rewraps every row, so every mark
 * comes off, every row is laid out once at the new width, and the marks go back.
 *
 * A row under a `hidden` element (a folded process group's body, a folded
 * turn's members) has no layout to remember, so it carries no mark: one marked
 * there would open at the fallback height, and the fold glide would measure
 * that height and roll the door to it. Every `hidden` flip takes the marks
 * off the rows under it, and a row is marked only while it is rendered.
 */

/** The mark a row carries once it has been laid out at its real size. */
export const LAID_OUT_ATTR = 'data-dsh-claude-laid-out'

/** Every flow row the host draws, whatever its kind. */
const ROW_SELECTOR = `[${FLOW_KIND_ATTRIBUTE}]`

export function install() {
  const rows = observeMatches<HTMLElement>(ROW_SELECTOR, () => collect())
  /** Rows that have not yet been through a layout without the mark. */
  let waiting = new Set<HTMLElement>()
  let cancelFrame: (() => void) | null = null
  /** The scroller whose width is heard, its subscription, and the width last reported. */
  let scroller: Element | null = null
  let stopWidth: (() => void) | null = null
  let width = 0

  /**
   * Mark the rows waiting now, two frames on: the first frame's layout is the one
   * that lays them out unmarked, and the mark lands before the second frame's.
   * A row arriving in between waits for the next round.
   */
  const schedule = () => {
    if (cancelFrame !== null || waiting.size === 0) return
    cancelFrame = requestFrame({
      write() {
        const queued = waiting
        waiting = new Set()
        /** The queued rows that were rendered, read before any mark is written. */
        let laidOut: HTMLElement[] = []
        cancelFrame = requestFrame({
          read() {
            // A row under a hidden element waits for the flip that shows it.
            laidOut = [...queued].filter(row => row.isConnected && row.checkVisibility())
          },
          write() {
            cancelFrame = null
            for (const row of laidOut) row.setAttribute(LAID_OUT_ATTR, '')
            schedule()
          },
        })
      },
    })
  }

  /** A `hidden` flip: the rows at and under the element lose their marks and wait for a layout. */
  const onHiddenFlip = (records: MutationRecord[]) => {
    for (const record of records) {
      const target = record.target
      if (!(target instanceof HTMLElement)) continue
      const under = target.matches(ROW_SELECTOR) ? [target, ...target.querySelectorAll<HTMLElement>(ROW_SELECTOR)] : target.querySelectorAll<HTMLElement>(ROW_SELECTOR)
      for (const row of under) {
        row.removeAttribute(LAID_OUT_ATTR)
        waiting.add(row)
      }
    }
    schedule()
  }

  /** Every row's mark comes off and every row waits for a layout of its own again. */
  const relayAll = () => {
    for (const row of rows.all()) {
      row.removeAttribute(LAID_OUT_ATTR)
      waiting.add(row)
    }
    schedule()
  }

  /**
   * Hear the conversation scroller's width; a session switch replaces it. Its
   * first report is the width as it stands, which changes nothing.
   */
  const followWidth = () => {
    const next = conversationScroller()
    if (next === scroller) return
    if (stopWidth !== null) stopWidth()
    stopWidth = null
    scroller = next
    width = 0
    if (next === null) return
    stopWidth = observeSize(next, (entries) => {
      const size = entries[entries.length - 1].borderBoxSize
      const inline = size !== undefined && size.length > 0 ? size[0].inlineSize : entries[entries.length - 1].contentRect.width
      const previous = width
      width = inline
      if (previous !== 0 && Math.abs(inline - previous) >= 0.5) relayAll()
    })
  }

  /** The rows that arrived without the mark wait for their first layout. */
  const collect = () => {
    followWidth()
    for (const row of rows.all()) {
      if (!row.hasAttribute(LAID_OUT_ATTR)) waiting.add(row)
    }
    schedule()
  }

  const stopHidden = subscribeMutations(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] }, onHiddenFlip)
  collect()

  return () => {
    stopHidden()
    if (stopWidth !== null) stopWidth()
    if (cancelFrame !== null) cancelFrame()
    for (const row of rows.all()) row.removeAttribute(LAID_OUT_ATTR)
    rows.release()
  }
}
