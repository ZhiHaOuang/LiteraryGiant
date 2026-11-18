import { observeMatches, observeSize, subscribeMutations } from '@dsh-claude-style/engine/bus'
import { CHAT_ROW_SELECTOR, conversationColumn, userBubble } from '@dsh-claude-style/engine/chat-dom'
import { buildElement, setAttributeIfChanged } from '@dsh-claude-style/engine/dom'
import { MESSAGE_FOLD_ATTR } from '../../constants'
import { SUBMISSION_ECHO_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { copy } from './copy'

/**
 * Fold a message the reader sent that is taller than the conversation can spare.
 *
 * The host renders a user message whole however long it is: a pasted trace or a
 * log dump stands in the column at its full height and pushes the rest of the
 * conversation away. Nothing in the host's markup offers a fold, so the skin
 * folds it — the bubble is clamped to the stylesheet's cap with its bottom edge
 * softened, and the skin's own toggle under it hands the whole message back. The
 * mark and the toggle are the skin's; the bubble, its words and the actions
 * beside it stay the host's.
 *
 * Both faces of a sent message are folded: the echo the host mounts the moment
 * the message goes out, and the durable row that replaces it. The reader sees
 * his message clamped as soon as it lands, not once the turn is over: the echo
 * is folded in the batch that mounts it rather than in the pass after, because
 * the send flight takes the bubble's box at take-off and carries its stand-in to
 * that box for the whole animation (chat-send/send-flight.ts).
 *
 * A message the reader opened stays open while its node stands — the choice is
 * kept per bubble, and every later pass re-applies it.
 *
 * The cap and the fade are the stylesheet's, read back off the bubble
 * (message-fold.css), so the threshold and the clamp are one number. A bubble is
 * read the first time it is seen and again whenever its own box moves: a row can
 * arrive before its own text has its final height.
 */

/** The toggle the skin draws under a foldable message: the stylesheet and the press route both read it. */
export const MESSAGE_FOLD_TOGGLE_CLASS = 'dsh-claude-message-fold-toggle'
/** What the cap and the fade fall back to when the stylesheet's own values cannot be read. */
const FALLBACKS = { cap: 320, fade: 40 }

/** What the reader asked for on one message. */
type FoldChoice = 'collapsed' | 'expanded'

/**
 * Watch every user message and fold the tall ones.
 *
 * @param requestPass - asks the scheduler for a pass (a box moved under the
 *     fold's own reading).
 * @returns the pass's read phase, its write phase, the two events that move a
 *     height, and the teardown.
 */
export function createMessageFold(requestPass: () => void) {
  /** Every row a submission is recognised by, kept current by the bus (D40). */
  const rows = observeMatches<HTMLElement>(CHAT_ROW_SELECTOR)
  /** The size subscription of each bubble read so far: the browser reports when its box moves. */
  const sizes = new Map<Element, () => void>()
  /** The reader's own choice per message. */
  const choices = new WeakMap<Element, FoldChoice>()
  /** The toggle standing under each bubble, while it stands. */
  const under = new WeakMap<Element, HTMLElement>()
  /** Which bubble a standing toggle belongs to, for the press route. */
  const owners = new WeakMap<HTMLElement, HTMLElement>()
  /** Row to the bubble the last walk found under it: a pass does not walk a row twice. */
  const bubbles = new WeakMap<Element, HTMLElement>()
  /** Whether a bubble's content is taller than the cap; absent until it has been read. */
  let decided = new WeakMap<Element, boolean>()
  /** The reading width the last pass was taken at; -1 until one is taken. */
  let measuredWidth = -1

  /** Forget every height read and ask for a pass: a change of copy re-wraps the words. */
  function invalidate() {
    decided = new WeakMap()
    requestPass()
  }

  /** The width the messages are read at: the column they stand in, or the window while there is none. */
  function columnWidth() {
    const column = conversationColumn()
    return column === null ? window.innerWidth : column.clientWidth
  }

  /**
   * The scheduler dispatches this for a scroll as well as a resize, and a scroll
   * moves no text: only a column of another width re-wraps the words. The folded
   * bubbles are the reason the width is read here — their box is held at the cap,
   * so their own size subscription never hears the words re-wrapping under it.
   */
  function reposition() {
    const width = columnWidth()
    if (measuredWidth === width) return
    const first = measuredWidth === -1
    measuredWidth = width
    // The first call only says which width the readings already in hand were
    // taken at; nothing is read again for it.
    if (!first) invalidate()
  }

  /** The bubble under one row, walked once per row until the host replaces it. */
  function bubbleOf(row: Element) {
    const held = bubbles.get(row)
    if (held !== undefined && held.isConnected) return held
    const bubble = userBubble(row)
    if (bubble !== null) bubbles.set(row, bubble)
    return bubble
  }

  /**
   * Hear one bubble's box, once.
   *
   * The row can stand before its own text has its final height (the host mounts
   * it before the fill or the words arrive), and the skin's own clamp moves the
   * box too, so the browser is the one that says when the answer may have
   * changed: the next pass reads the content's height again.
   */
  function watchSize(bubble: HTMLElement) {
    if (sizes.has(bubble)) return
    sizes.set(bubble, observeSize(bubble, () => {
      decided.delete(bubble)
      requestPass()
    }))
  }

  /**
   * Whether this bubble's content is taller than the cap.
   *
   * scrollHeight is the content's own height, which the clamp never hides, so
   * the answer holds in both states.
   */
  function decide(bubble: HTMLElement) {
    const known = decided.get(bubble)
    if (known !== undefined) return known
    watchSize(bubble)
    if (measuredWidth === -1) measuredWidth = columnWidth()
    const style = getComputedStyle(bubble)
    const cap = Number.parseFloat(style.getPropertyValue('--dsh-claude-message-fold-cap')) || FALLBACKS.cap
    const fade = Number.parseFloat(style.getPropertyValue('--dsh-claude-message-fold-fade')) || FALLBACKS.fade
    const tall = bubble.scrollHeight >= cap + fade
    decided.set(bubble, tall)
    return tall
  }

  /** The skin's own toggle under one bubble, built the first time it is needed. */
  function buildToggle(bubble: HTMLElement) {
    const toggle = buildElement('button', MESSAGE_FOLD_TOGGLE_CLASS)
    toggle.type = 'button'
    // No aria-expanded: the chat fold's own door takes every [aria-expanded]
    // control for a host disclosure (fold-glide.ts), and this control is the
    // skin's; its label says which way the press goes.
    owners.set(toggle, bubble)
    under.set(bubble, toggle)
    // The toggle stands after the bubble, inside the host's own message stack:
    // React owns that container, so the pass puts the toggle back whenever it goes.
    bubble.after(toggle)
    return toggle
  }

  /** Take one bubble's toggle down. */
  function dropToggle(bubble: HTMLElement) {
    const toggle = under.get(bubble)
    if (toggle === undefined) return
    under.delete(bubble)
    owners.delete(toggle)
    if (toggle.isConnected) toggle.remove()
  }

  /** The toggle's words say what pressing it does. */
  function writeLabel(toggle: HTMLElement, collapsed: boolean) {
    const text = collapsed ? copy('messageFoldMore') : copy('messageFoldLess')
    if (toggle.textContent !== text) toggle.textContent = text
  }

  /** Bring one bubble to what its height and the reader's own choice ask for. */
  function apply(bubble: HTMLElement, tall = decided.get(bubble) === true) {
    const collapsed = tall && choices.get(bubble) !== 'expanded'
    if (collapsed) setAttributeIfChanged(bubble, MESSAGE_FOLD_ATTR, 'collapsed')
    else bubble.removeAttribute(MESSAGE_FOLD_ATTR)
    if (!tall) {
      dropToggle(bubble)
      return
    }
    const standing = under.get(bubble)
    const toggle = standing !== undefined && standing.isConnected ? standing : buildToggle(bubble)
    writeLabel(toggle, collapsed)
  }

  /**
   * The reader pressing the skin's own toggle: the message takes the other state.
   *
   * The press is caught before the row hears it — the row belongs to the host,
   * and a click on it may mean something else (a selection, the whole turn) —
   * and it never reaches the fold's own door, which rolls host disclosures.
   */
  const onPress = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const toggle = target.closest('.' + MESSAGE_FOLD_TOGGLE_CLASS)
    if (!(toggle instanceof HTMLElement)) return
    const bubble = owners.get(toggle)
    if (bubble === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const expanded = choices.get(bubble) === 'expanded'
    choices.set(bubble, expanded ? 'collapsed' : 'expanded')
    apply(bubble, decide(bubble))
  }

  /**
   * Read one row and write it in the same task: what a pass does for it, for the
   * one row a pass would reach a frame too late (the echo watch below).
   */
  function settleRow(row: Element) {
    const bubble = bubbleOf(row)
    if (bubble === null) return
    decide(bubble)
    apply(bubble)
  }

  /** Read every bubble the fold has no answer for (the pass's read phase, D40). */
  function measure() {
    for (const row of rows.all()) {
      const bubble = bubbleOf(row)
      if (bubble !== null) decide(bubble)
    }
  }

  /**
   * Write every mark and toggle (the pass's write phase, D40). The bubbles are
   * the ones the read phase found: walking a row here reads computed styles
   * after the other features' writes, a style recalculation on every pass.
   */
  function sync() {
    for (const row of rows.all()) {
      const bubble = bubbles.get(row)
      if (bubble !== undefined && bubble.isConnected) apply(bubble)
    }
  }

  /**
   * The echo the host mounts the moment a submission goes through, folded in the
   * batch that mounts it.
   *
   * The send flight (chat-send/send-flight.ts) measures the bubble it hands the
   * message to and carries its stand-in to that box, so a fold landing in the
   * pass after the echo mounts leaves the stand-in flying to the message's full
   * height and holds the real row back until the flight's own wait runs out. This
   * watch is made at install and the flight's own only once a submission has been
   * captured, so this callback runs first and the flight measures what it wrote.
   */
  const stopEchoWatch = subscribeMutations(document.body, { childList: true, subtree: true, skipQuiet: true }, records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(SUBMISSION_ECHO_SELECTOR)) settleRow(node)
        for (const echo of node.querySelectorAll(SUBMISSION_ECHO_SELECTOR)) settleRow(echo)
      }
    }
  })

  document.addEventListener('click', onPress, true)

  return {
    measure,
    sync,
    reposition,
    /** A change of copy re-wraps and relabels: the next pass reads every height again. */
    onCopyChange: invalidate,
    stop() {
      document.removeEventListener('click', onPress, true)
      stopEchoWatch()
      // The mark stands on the bubble and the toggle under it, and the registry
      // is still live at teardown: nothing else has to be remembered.
      for (const row of rows.all()) {
        const bubble = bubbles.get(row)
        if (bubble === undefined) continue
        bubble.removeAttribute(MESSAGE_FOLD_ATTR)
        dropToggle(bubble)
      }
      for (const stop of sizes.values()) stop()
      sizes.clear()
      rows.release()
    },
  }
}
