import { subscribeMutations } from '@dsh-claude-style/engine/bus'
import { requestFrame } from '@dsh-claude-style/engine/frame'
import { CHAT_FLYING_ATTR, MESSAGE_ENTER_GROW, MESSAGE_FOLD_ATTR } from '../../constants'
import { motionReduced, readPrefs } from '../../core/prefs'
import { startMorph } from './send-morph'
import { currentRow, lastUserRow, takeFreshEcho, touchesUserRow } from './send-rows'
import { watchGrowEnter } from './send-grow'
import { CHAT_FLIGHT_MS, CHAT_LANDING_MS } from './send-shape'
import { snapshotComposer } from './send-snapshot'
import { CHAT_FLOW_SELECTOR, COMPOSER_CARD_SELECTOR, COMPOSER_INPUT_SELECTOR, FLOW_KIND_ATTRIBUTE, SUBMISSION_ECHO_SELECTOR, USER_ROW_KIND } from '@dsh-claude-style/contracts/dom'
import { CHAT_USER_ROW_SELECTOR, userBubble } from '@dsh-claude-style/engine/chat-dom'
import { motionEase } from '../../shared/motion'
import { inPageBox, pageViewport } from '../../shared/page-zoom'
import type { HostContext } from '@dsh-claude-style/engine/host'
import type { FeatureHandle } from '@dsh-claude-style/engine/scheduler'
import type { FeatureUi } from '../../core/feature'
import type manifest from './send-flight.manifest'
import type { ComposerSnapshot } from './send-snapshot'

/** A submission's origin: the composer card read at the press. */
interface SendOrigin {
  capturedAt: number
  snapshot: ComposerSnapshot
}

/** One flight in progress. */
interface Flight {
  morph: NonNullable<ReturnType<typeof startMorph>>
  /** Where the bubble was at take-off, and how far the stand-in has followed it since. */
  targetAt: { left: number, top: number }
  shiftedX: number
  shiftedY: number
  previous: HTMLElement | null
  hidden: HTMLElement | null
  landing: boolean
  /** Whether the flight is holding for a row to land on (see land()). */
  waiting: boolean
  /** Frames the stand-in and the row have both held still for (see arrived()). */
  stable: number
  /** The row's own box last frame, what `held` in arrived() compares against. */
  rowTop: number | null
  rowHeight: number
  /** When the stand-in first stood close enough to the row to end the wait early (arrived()). */
  nearAt: number | null
  /** When the flight's own animation ended, the start of the wait's hard ceiling (arrived()). */
  endedAt: number | null
  landedRow: HTMLElement | null
  bubble: HTMLElement | null
}

/** The origin is only trusted this long: an echo that appears later than this is not this submission's. */
export const CHAT_ORIGIN_TTL_MS = 1500
/**
 * The floor under the displacement limit; a screen narrower than it uses the
 * floor.
 */
export const CHAT_FLIGHT_LIMIT_FLOOR_PX = 900

/**
 * The backstop keeps a good while longer than the flight itself: the stand-in
 * holds until it has stood on the row for CHAT_ARRIVED_FRAMES (arrived()), and a
 * transcript still gliding to its tail can take a tenth of a second past the
 * flight's own end. A throttled background timer still has to release the message
 * before the reader comes back.
 */
export const CHAT_RESCUE_MARGIN_MS = 1500

/**
 * How long the stand-in waits for a row to hand the message over to.
 *
 * The echo can be gone before the real row mounts — the echo lives about 159 ms
 * while the real row takes over a second — so the flight can finish with nothing
 * at the destination. This is the backstop for that window: the stand-in stays
 * visible until a row is there, and a host that never mounts one gets the page
 * back when the wait runs out.
 */
export const CHAT_HANDOVER_WAIT_MS = 2500

/** Only an echo inside the chat flow counts: one waiting in the queue dock is another transition, not this one. */
export const CHAT_ECHO_SELECTOR = CHAT_FLOW_SELECTOR + ' ' + SUBMISSION_ECHO_SELECTOR

/**
 * How close the stand-in has to be to the row before the row may be shown
 * (arrived()). Half a pixel: the landing's own spring give is a fraction of a
 * pixel, and anything a reader could see as two pictures of one message is
 * larger than that.
 */
export const CHAT_ARRIVED_PX = 0.5

/**
 * How close the stand-in has to be before the wait for stillness is shortened
 * (arrived()): at this gap the two pictures already agree to the eye.
 */
export const CHAT_ARRIVED_NEAR_PX = 3

/**
 * The longest the flight holds a settled destination before showing the row
 * anyway (arrived()). The wait is for the row to stop moving, and a page that
 * keeps changing around it — the reader's own scrolling, a stream growing below
 * — would otherwise hold the message away for good. Measured: the hand-over's own
 * wait is two frames when the row is still; this ceiling is the backstop.
 */
export const CHAT_ARRIVED_CEILING_MS = 500

/**
 * How many frames in a row the stand-in has to stand on the row before the row
 * may be shown (arrived()): one frame of slack for a layout the host changes in
 * its own frame, which this flight can only read a frame later.
 */
export const CHAT_ARRIVED_FRAMES = 8

/** A settled user row. It and the echo row are two faces of one component, a level apart (send-rows.ts). */

/** What the rest of the skin reads off the entrance (ui.chatSend). */
export interface ChatSendHandle extends FeatureHandle {
  /** Whether the reader's message is still taking its place: a flight in the air, or its row growing where it landed. */
  isEntering(): boolean
}

/**
 * The send bubble's take-off, ported from dsh-chat-ux.
 *
 * After a submission the host mounts an echo bubble at once and swaps it for
 * the real row the moment that arrives. Measured: the echo lives 159 ms while
 * the real row takes over a second. An animation hung on either node is dead on
 * arrival (on the echo it loses its node midway; waiting for the real row leaves
 * a second of nothing), so this draws a stand-in of its own: a copy of the
 * composer card lifts off and narrows into the bubble as it travels. How the
 * stand-in is built and how the shape is worked out is in send-morph.ts; this
 * module decides when it takes off, where it flies and when it lands.
 *
 *   capture   the submission's capture phase takes the whole composer card
 *             (clone, geometry, looks), all before React clears the draft.
 *   notice    the echo row is noticed the moment it mounts, through a
 *             MutationObserver rather than a per-frame poll.
 *   launch    the stand-in goes on the page and the whole animation goes to
 *             the compositor; the real row is marked and hidden (keeping its
 *             layout box, so the destination can be measured every frame).
 *   per frame exactly two things: how far the destination moved (the host
 *             scrolling to the end, the echo becoming the real row) is added to
 *             the stand-in's outer layer; and once the shape's stretch is over,
 *             the shell is normalised (see send-morph.ts's compact). Position,
 *             shape, colour and the words' re-flow are all on the compositor,
 *             so they keep moving while the host parses a response on the main
 *             thread.
 *   land      unmark the real row and fade the stand-in out over it
 *             (CHAT_LANDING_MS), then drop the stand-in — the real row is
 *             already at the destination, so the hand-over moves nothing,
 *             and the fade carries the words from the stand-in's rendering
 *             to the page's (see land()). The echo being gone before the real
 *             row mounts holds the stand-in where it is until a row is there.
 *
 * Five edges:
 *
 *   Hide in the same frame   the observer's callback runs before this frame
 *                            paints, so the real row is never shown for a frame;
 *                            a frame later the reader sees a normal bubble
 *                            flash and then be wiped.
 *   Notice outside the frame  "at once" is not "every frame": the echo being
 *                            swapped for the real row is recognised
 *                            synchronously before this frame paints, and asking
 *                            again in the frame is wasted work.
 *   No origin, no flight     when the origin cannot be captured (a keyboard
 *                            shortcut, a programmatic submission) nothing is
 *                            done and the reader sees the host's own behaviour.
 *   Hidden must be returned  while the real row is hidden the reader cannot see
 *                            that message, so besides the normal landing there
 *                            is a timer as a backstop: rAF stops in a hidden
 *                            tab, the stand-in stops, and the mark must not stay.
 *   One screen only          with either end off screen the stand-in would
 *                            vanish at the edge and the message would look like
 *                            it appeared out of nothing, so it does not fly.
 * @returns teardown: the listeners go, and a flight in progress — a hidden
 *     message included — is settled.
 */
export function install(ctx: HostContext, ui: FeatureUi<typeof manifest>) {
  /** The origin captured last. */
  let origin: SendOrigin | null = null
  /** The echo rows already dealt with; the ones lying on the page at install time are included (a restored session has them). */
  const handled = new WeakSet<Element>()
  /** The flight in progress. With the reader sending twice, the last one wins. */
  let flight: Flight | null = null
  /** The backstop timer. */
  let rescue = 0

  for (const echo of document.querySelectorAll(CHAT_ECHO_SELECTOR)) handled.add(echo)

  /**
   * Watch the row during a flight: the echo being swapped for the real row is
   * the one thing that has to be known at once.
   *
   * It runs before this frame paints, so one synchronous look is enough; and
   * only rows arriving or leaving are looked at — the pre-filter checks the
   * added and removed nodes themselves, since both marks sit on the row
   * element and finding the row needs no subtree walk.
   */
  const onRowRecords = (records: MutationRecord[]) => {
    const activeFlight = flight
    if (activeFlight === null || !touchesUserRow(records)) return
    const row = currentRow(activeFlight.previous)
    if (row === null || row === activeFlight.hidden || row === activeFlight.landedRow) return
    // Landing, the real row is already showing under the fading stand-in:
    // a row swapped in now is followed, not hidden.
    if (activeFlight.landing) {
      activeFlight.landedRow = row
    } else {
      activeFlight.hidden?.removeAttribute(CHAT_FLYING_ATTR)
      row.setAttribute(CHAT_FLYING_ATTR, '')
      activeFlight.hidden = row
    }
    activeFlight.bubble = userBubble(row)
    followTarget(activeFlight)
  }
  /** Stops the row watch; set only while a flight is in the air. */
  let stopRowWatch: (() => void) | null = null
  const unwatchRows = () => {
    if (stopRowWatch !== null) stopRowWatch()
    stopRowWatch = null
  }

  /**
   * Hand the stand-in over to the real bubble: show the real row under it and
   * fade the stand-in out over CHAT_LANDING_MS, still following the
   * destination, then settle.
   *
   * Nothing is handed over while no row is on the page: the host can take the
   * echo away before the real row mounts, and fading then would carry the
   * reader's message into the page and put it back a second later — the bubble
   * turning white and then blue again. The stand-in holds instead, still
   * visible and still following, until the observer recognises a row to land on.
   *
   * The two are the same bubble in the same place, but they are not drawn
   * alike: the stand-in flies on compositor layers, and a transparent layer
   * draws its words with greyscale antialiasing where the page draws the
   * real bubble's with the screen's subpixel antialiasing (ClearType on
   * Windows). Swapped in one frame, the words visibly darken and change
   * weight the instant the flight ends; faded across, they sharpen into the
   * real ones.
   */
  const land = () => {
    const activeFlight = flight
    if (activeFlight === null || activeFlight.landing) return
    const row = activeFlight.hidden
    if (row === null || !row.isConnected) {
      // One re-arm only: this runs every frame, and the wait is the page's
      // last resort rather than a per-frame timer.
      if (!activeFlight.waiting) {
        activeFlight.waiting = true
        window.clearTimeout(rescue)
        rescue = window.setTimeout(settle, CHAT_HANDOVER_WAIT_MS)
      }
      return
    }
    activeFlight.landing = true
    row.removeAttribute(CHAT_FLYING_ATTR)
    activeFlight.hidden = null
    activeFlight.landedRow = row
    // The stand-in is put exactly on the row in this frame. arrived() has just
    // said the two are within a pixel or two, and this fade is the only thing
    // between the reader and the real row: a stand-in that is a few pixels out is
    // a second copy of the same message drifting over it.
    followTarget(activeFlight, true)
    const fade = activeFlight.morph.wrapper.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: CHAT_LANDING_MS,
      easing: motionEase('--dsh-claude-ease-out'),
      fill: 'forwards',
    })
    activeFlight.morph.animations.push(fade)
    // The handler rather than the `finished` promise: settling cancels this
    // animation, and a cancelled animation rejects its promise.
    fade.onfinish = () => {
      if (flight === activeFlight) settle()
    }
  }

  /**
   * Hand over only once the stand-in has arrived.
   *
   * The take-off transform is built for where the destination stood at that
   * moment (send-shape.ts's `end`), and the host keeps moving the row after it:
   * the transcript glides to the tail, the echo row becomes the real one, and a
   * row that arrived while the new one is still growing settles somewhere else.
   * Showing the real row before the stand-in has caught up leaves both on screen
   * at once — two copies of the same message, tens of pixels apart — for as long
   * as the landing fade lasts, which reads as a flicker. Measured with real turns
   * on this build: the row moved 55 to 109 px once, hundreds of milliseconds
   * after the flight was over, while the transcript glided to its tail.
   *
   * So the wait is for stillness, not for arrival: the stand-in is within half a
   * pixel of the row AND the row's own box has held still for
   * CHAT_ARRIVED_FRAMES. The host changes layout in its own frame, which this
   * flight reads one frame late: a gate on a single frame's reading lets a row
   * that is about to move through.
   *
   * The wait is bounded, because a page that keeps changing around the flight (the
   * reader scrolling, a stream growing below) would otherwise hold the row away for
   * good — the flight's own animation has been over since the first frame of this
   * wait, so nothing else ends it. Two ceilings: a gap already too small to see
   * shortens the wait, and the flight's own end plus
   * CHAT_ARRIVED_CEILING_MS ends it whatever the page is doing. land() snaps the
   * row onto the stand-in in that frame, so the pair agrees even then.
   * @returns true when the row may be shown.
   */
  const arrived = (value: Flight) => {
    const row = value.hidden
    const bubble = value.bubble
    if (row === null || bubble === null) return false
    const shell = value.morph.shell
    if (shell === null) return false
    const here = shell.getBoundingClientRect()
    const there = bubble.getBoundingClientRect()
    // A row with no box yet is not somewhere to land: hold, as land() does.
    if (there.width === 0) return false
    const gap = Math.max(Math.abs(here.top - there.top), Math.abs(here.left - there.left), Math.abs(here.height - there.height))
    const held = value.rowTop !== null
      && Math.abs(there.top - value.rowTop) < CHAT_ARRIVED_PX
      && Math.abs(there.height - value.rowHeight) < CHAT_ARRIVED_PX
    value.rowTop = there.top
    value.rowHeight = there.height
    if (gap >= CHAT_ARRIVED_NEAR_PX) {
      value.nearAt = null
      value.stable = 0
    } else {
      if (gap < CHAT_ARRIVED_PX && held) {
        value.stable += 1
        if (value.stable >= CHAT_ARRIVED_FRAMES) return true
      } else {
        value.stable = 0
      }
      const now = performance.now()
      if (value.nearAt === null) value.nearAt = now
      if (now - value.nearAt >= CHAT_ARRIVED_CEILING_MS) return true
    }
    const ended = value.endedAt
    return ended !== null && performance.now() - ended >= CHAT_ARRIVED_CEILING_MS
  }

  /** Land: release the real row first, then drop the stand-in. Reversed, a blank flashes. */
  const settle = () => {
    const activeFlight = flight
    if (activeFlight === null) return
    flight = null
    unwatchRows()
    window.clearTimeout(rescue)
    rescue = 0
    activeFlight.hidden?.removeAttribute(CHAT_FLYING_ATTR)
    // The stand-in leaves the document **before** its animations are
    // cancelled, never the other way round. Cancelling returns the halo to
    // "never moved" — as large as the whole composer card — and the halo's
    // run mixes scale and opacity into one compositable animation: the cancel
    // goes through the compositor, the node removal goes through the
    // compositor, and the wrong order paints one extra frame, which the reader
    // sees as the width stretching and snapping back. Once the node is out of
    // the document its animations are void, and the cancel below only clears
    // the references.
    activeFlight.morph.wrapper.remove()
    for (const animation of activeFlight.morph.animations) animation.cancel()
  }

  /**
   * Three things per frame: notice the shape's stretch is over and normalise
   * the shell, add the destination's movement, and book the next frame.
   * Recognising the row is the observer's job above — it is not a
   * per-frame question.
   *
   * Neither the displacement nor the shape is written here: the two keyframe
   * runs share one timeline (one duration, one set of offsets) and keep running
   * together through the tens to hundreds of milliseconds the host holds the
   * main thread, so the right-edge equation in send-shape.ts holds throughout.
   * This path was burnt once: the displacement on the compositor with the shape
   * left in a main-thread `clip-path`, and a stall flew a card that had not
   * narrowed to the destination.
   *
   * The other two are main-thread work: `compact` writes styles once, and
   * `followTarget` reads the current layout.
   */
  const tick = () => {
    const activeFlight = flight
    if (activeFlight === null) return
    const u = activeFlight.morph.progress()
    activeFlight.morph.compact(u)
    if (activeFlight.endedAt === null && u >= 1) activeFlight.endedAt = performance.now()
    if (!activeFlight.landing) {
      followTarget(activeFlight)
      if (u >= 1 && arrived(activeFlight)) land()
    } else {
      // Through the fade the stand-in is pinned to the row: read and write in the
      // same task, so no frame of lag. The row has settled by then — arrived()
      // waits for that — but the host can still move it a few pixels (the
      // transcript gliding to its tail), and a stand-in left a few pixels short
      // uncovers the row's own foot, which reads as a line under the message.
      followTarget(activeFlight, true)
    }
    requestFrame({ write: tick })
  }

  /** Start one flight: stand-in up, real row hidden. All of it synchronously — a frame later the reader sees the real bubble flash. */
  const startFlight = (echo: HTMLElement, draft: SendOrigin) => {
    // A flight still going is settled first: otherwise the old stand-in stays
    // on the page for ever (one ghost per extra send) and the old real row
    // keeps its hide mark, so the reader never sees that message again. With
    // the reader sending twice, the last flight wins.
    settle()
    const bubble = userBubble(echo)
    if (bubble === null) return
    // Both ends of the flight, and the window they have to share, in the page's
    // own pixels: that is the space the stand-in's styles are read in
    // (shared/page-zoom.ts).
    const box = inPageBox(bubble.getBoundingClientRect())
    const card = draft.snapshot.box
    const viewport = pageViewport()
    const onSameScreen = sameScreen(card.left, box.left, viewport.width)
      && sameScreen(card.top, box.top, viewport.height)
    if (!onSameScreen) return
    // A message the fold holds flies as the folded message it will stand as
    // (send-morph.ts's capped flight).
    const morph = startMorph(draft.snapshot, bubble, box, bubble.hasAttribute(MESSAGE_FOLD_ATTR))
    if (morph === null) return
    echo.setAttribute(CHAT_FLYING_ATTR, '')
    flight = {
      morph,
      targetAt: { left: box.left, top: box.top },
      shiftedX: 0,
      shiftedY: 0,
      previous: lastUserRow(),
      hidden: echo,
      // Whether the flight has landed and is fading across to the real row, and that row.
      landing: false,
      waiting: false,
      stable: 0,
      rowTop: null,
      rowHeight: 0,
      nearAt: null,
      endedAt: null,
      landedRow: null,
      bubble,
    }
    if (stopRowWatch === null) stopRowWatch = subscribeMutations(document.body, { childList: true, subtree: true }, onRowRecords)
    rescue = window.setTimeout(settle, CHAT_FLIGHT_MS + CHAT_LANDING_MS + CHAT_RESCUE_MARGIN_MS)
    // The flight compacts the card and follows the destination's layout: write phase (D40).
    requestFrame({ write: tick })
  }

  /**
   * Wait for this submission's echo.
   *
   * Only hung up once an origin has been captured (so there are no callbacks the
   * rest of the time), and taken off the moment it is recognised, times out or
   * is given up on.
   */
  let stopEchoWatch: (() => void) | null = null
  const unwatchEcho = () => {
    if (stopEchoWatch !== null) stopEchoWatch()
    stopEchoWatch = null
  }
  const onEchoRecords = () => {
    const draft = origin
    if (draft === null) {
      unwatchEcho()
      return
    }
    if (performance.now() - draft.capturedAt > CHAT_ORIGIN_TTL_MS) {
      origin = null
      unwatchEcho()
      return
    }
    const echo = takeFreshEcho(handled)
    if (echo === null) return
    origin = null
    unwatchEcho()
    startFlight(echo, draft)
  }

  /** Capture an origin once. Not capturing it counts as "this was not a submission", and doing nothing is always safe. */
  const captureOrigin = () => {
    // The reader's animation choice, resolved and read here rather than once
    // at install (D40): a still page is a decision the reader can change
    // without a reload, and the resolved answer is what the rest of the skin
    // reads — the media query cannot express "always play".
    if (motionReduced()) return
    // Growing into place needs no origin: the echo alone says a message was
    // sent, and snapshotting the card would only cost a clone (send-grow.ts).
    if (readPrefs().messageEnter === MESSAGE_ENTER_GROW) return
    const input = document.querySelector(COMPOSER_INPUT_SELECTOR)
    if (!(input instanceof HTMLElement)) return
    const card = input.closest(COMPOSER_CARD_SELECTOR)
    if (!(card instanceof HTMLElement)) return
    // An empty draft submits no message, and measuring it would only waste a clone.
    if ((input.textContent ?? '').trim() === '') return
    const snapshot = snapshotComposer(input, card)
    if (snapshot === null) return
    origin = { capturedAt: performance.now(), snapshot }
    if (stopEchoWatch === null) stopEchoWatch = subscribeMutations(document.body, { childList: true, subtree: true }, onEchoRecords)
  }

  /**
   * The two manual submission paths: Enter, and pressing a button inside the
   * composer card. Both run before React clears the draft, so the origin can be
   * measured. Pressing without submitting costs nothing — no echo, no flight.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.isComposing) return
    captureOrigin()
  }

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest(COMPOSER_CARD_SELECTOR) === null) return
    captureOrigin()
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('click', onClick, true)
  // The other answer to the same question (constants.ts MESSAGE_ENTER_MODES):
  // the message grows where it lands instead of flying, and that path needs no
  // origin snapshot at all. Both run; whichever the reader picked does the work.
  const grow = watchGrowEnter()

  /**
   * Whether the reader's message is still taking its place: a flight is in the
   * air (through its landing fade) or the row is growing where it landed. The
   * follow reads this where it used to wait out a window timed from the row's
   * arrival (features/chat-follow): the slide stands down exactly while this
   * entrance reads the row's own box, and not a moment longer.
   */
  ui.chatSend = {
    isEntering: () => flight !== null || grow.entering(),
  }

  return () => {
    delete ui.chatSend
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', onClick, true)
    grow.stop()
    unwatchEcho()
    unwatchRows()
    origin = null
    settle()
  }
}

/** A draft the instant before it takes off: the whole composer card's snapshot. */
/** A flight in progress. `hidden` is repointed when the echo is swapped for the real row. */
/**
 * Add how far the destination moved to the stand-in's outer layer, and take the
 * destination's own node again when the one held is gone.
 *
 * This is the frame's only JavaScript: one rect read and at most one style
 * write. The destination usually moves a few dozen pixels during a flight (the
 * host scrolls to the end after a submission, the echo becomes the real row),
 * and the echo row is taken away and a new row mounted in its place, so the node
 * the flight was pointed at can leave the document mid-flight. A remembered node
 * off the document measures as a zero box: the stand-in then holds where it is
 * for the rest of the flight, lands tens of pixels away from the row, and both
 * are on screen at once through the landing fade (arrived() in the installer).
 */
export function followTarget(value: Flight, snap = false) {
  let bubble = value.bubble
  // The node the destination was taken from can stop being the row's own: the
  // echo row is unmounted once the real one is there, and the host can mount
  // another echo or swap the row again while this flight still points at the
  // one before it. A stale node off the document measures as a zero box, and the
  // stand-in then holds where it is for the rest of the flight — the reader
  // waits on a message that never arrives. So the destination is taken from the
  // row the flight is holding, every frame.
  const held = value.hidden === null ? null : userBubble(value.hidden)
  if (held !== null && bubble !== held) bubble = held
  if (bubble === null) return
  let box = inPageBox(bubble.getBoundingClientRect())
  // The row the flight holds can leave the document while the stand-in still
  // flies (the echo becoming the real row), and a node off the document measures
  // a zero box. Holding still there leaves the stand-in hundreds of pixels off a
  // row that is already showing — the same message twice, one above the other —
  // so the destination is taken from the row on the page, by the rule the row
  // watch uses. Once the row is back, the frame closes the difference whole.
  if (box.width === 0) {
    const row = currentRow(value.previous) ?? value.landedRow
    const fresh = row === null ? null : userBubble(row)
    if (fresh === null || fresh === bubble) return
    bubble = fresh
    box = inPageBox(bubble.getBoundingClientRect())
    if (box.width === 0) return
  }
  if (bubble !== value.bubble) {
    value.bubble = bubble
    // The new node's own position is where the stand-in is being carried from,
    // so the shift is measured against it rather than against the old row's.
    value.targetAt = { left: box.left, top: box.top }
    value.shiftedX = 0
    value.shiftedY = 0
    // The stand-in is elsewhere in the frame the destination is taken again —
    // this is also the hand-over's own frame (land()) — so that frame closes the
    // difference whole rather than gliding it: a fade across two pictures of the
    // same message is exactly what the reader sees as a flicker.
    snap = true
  }
  const shiftX = box.left - value.targetAt.left
  const shiftY = box.top - value.targetAt.top
  if (!snap && shiftX === value.shiftedX && shiftY === value.shiftedY) return
  value.shiftedX = shiftX
  value.shiftedY = shiftY
  value.morph.wrapper.style.transform = 'translate(' + shiftX + 'px, ' + shiftY + 'px)'
}

/**
 * Are the two ends still on one screen?
 *
 * The screen's extent is read from the viewport on that axis (the floor is
 * CHAT_FLIGHT_LIMIT_FLOOR_PX): while both boxes are still on the screen the
 * flight is visible, and with one end off it the stand-in would vanish at the
 * edge and the message would look like it appeared out of nothing, so it does
 * not fly.
 */
export function sameScreen(start: number, end: number, viewportExtent: number) {
  return Math.abs(start - end) <= Math.max(CHAT_FLIGHT_LIMIT_FLOOR_PX, viewportExtent)
}
