import { requestFrame } from '@dsh-claude-style/engine/frame'
import { MODEL_EFFORT_DEFAULT, MODEL_EFFORT_FASTER, MODEL_EFFORT_LABEL, MODEL_EFFORT_NONE, MODEL_EFFORT_SMARTER } from '../model/model-labels'
import { effortSteps } from './ladder'
import type { EffortStep } from './ladder'
import { createEffortMatrix } from './matrix'
import { buildElement, setAttributeIfChanged } from '@dsh-claude-style/engine/dom'
import { inPagePixels } from '../../shared/page-zoom'
import { withoutTransition } from '../../shared/transition'
import { createNameSwap } from './name-swap'
import type { ModelCatalog } from '../model/catalog'
import { copy } from './copy'

/** The words around the slider. */
interface EffortLabels {
  label: string
  faster: string
  smarter: string
  none: string
}

/** The knob's width and the track's, in the pixels the travel is written in. */
export interface EffortTrackBox {
  size: number
  width: number
}

/**
 * The reasoning-effort slider inside the effort picker's card
 * (packages/client/src/features/effort/effort-picker.ts).
 *
 * The catalog describes a model's reasoning as a discrete ladder
 * (`reasoning.efforts` plus the level in force), and this control draws that
 * ladder as a track ordered by strength (ladder.ts): the label carries the
 * level's name, `Faster` / `Smarter` name the direction of travel, and the
 * knob follows the pointer
 * CONTINUOUSLY rather than hopping stop to stop. The value settles only at
 * the release, on the NEAREST level, so dragging never reads as a hard switch
 * between fixed positions.
 *
 * The face of the control follows Claude Desktop's effort slider: a filled
 * portion grows from the left end to the knob, one tick dot marks every
 * stop the ladder offers, and the TOP rung is special — reaching it swaps
 * the plain fill for a dot-matrix (effort/matrix.ts) in the manner of Claude's
 * Ultracode field (the grid is solved in whole device pixels, the phases
 * scattered by hash, the entrance swept in from the right, in the manner of
 * the community skin-switcher plugin), tints the knob, and colours the level's
 * name. The matrix and the whole name ramp take the reader's theme accent.
 *
 * A seat that names no levels (the catalog has not produced a ladder yet)
 * leaves the slider in its empty state: the knob travels the same way and
 * eases back to its resting end, but there is nothing to snap to and
 * nothing to select.
 *
 * The element is built once and never detached (effort-picker.ts): a
 * detach mid-gesture would drop the pointer capture, and a re-insertion
 * restarts its CSS animations.
 *
 * @param opts - `{ read, onPick, onDragStart, onDragEnd }`. `read()` returns
 *   the current seat's effort descriptor — the model picker's `effort()`,
 *   held over while a selection is in flight — or null,
 *   `onPick(levelId)` commits one level — `undefined` is the
 *   model's own default level — and `onDragEnd(event)` hears the release
 *   wherever it lands, the pointer outside the card included.
 * @returns `{ el, update, isHeld }`.
 */
export function createEffortControl(opts: {
  read: () => ReturnType<ModelCatalog['effort']>
  onPick: (levelId: string | undefined) => void
  onDragStart?: () => void
  onDragEnd?: (event: PointerEvent) => void
}) {
  const root = buildElement('div', 'dsh-claude-effort')
  const head = buildElement('div', 'dsh-claude-effort-head')
  const labelEl = buildElement('span', 'dsh-claude-effort-label')
  const valueEl = buildElement('span', 'dsh-claude-effort-value')
  /* The name being travelled to, absolutely positioned over the value: the
     slider's own travel is its progress, so the incoming words sit where the
     knob has not reached yet and take no layout space. */
  const valuePreview = buildElement('span', 'dsh-claude-effort-value-preview')
  const ends = buildElement('div', 'dsh-claude-effort-ends')
  const fasterEl = buildElement('span', 'dsh-claude-effort-end')
  const smarterEl = buildElement('span', 'dsh-claude-effort-end')
  const track = buildElement('div', 'dsh-claude-effort-track')
  const fill = buildElement('div', 'dsh-claude-effort-fill')
  const ticks = buildElement('div', 'dsh-claude-effort-ticks')
  const matrix = buildElement('div', 'dsh-claude-effort-matrix')
  const knob = buildElement('div', 'dsh-claude-effort-knob')

  head.appendChild(labelEl)
  head.appendChild(valueEl)
  head.appendChild(valuePreview)
  ends.appendChild(fasterEl)
  ends.appendChild(smarterEl)
  /* Paint order is DOM order: the fill under the ticks, the matrix over
     both, and the opaque knob on top — it covers whatever it rides over. */
  track.appendChild(fill)
  track.appendChild(ticks)
  track.appendChild(matrix)
  track.appendChild(knob)
  root.appendChild(head)
  root.appendChild(ends)
  root.appendChild(track)
  track.setAttribute('role', 'slider')
  track.setAttribute('tabindex', '0')
  /** The top rung's dot matrix (effort/matrix.ts). */
  const dotMatrix = createEffortMatrix(track, matrix)

  /** The ladder in force, the level it is on, and the words around it. */
  let steps: EffortStep[] = []
  let selected = -1
  let live = -1
  /** The knob's travel, in the same pixels its translate uses. */
  let liveTravel = 0
  /** Which way the knob last moved: 1 toward stronger, -1 toward weaker, 0 still. */
  let moveDirection = 0
  /**
   * A press and a drag are two states, not one. `pressed` starts on
   * pointerdown and the knob GLIDES to the press position (the stylesheet's
   * translate transition is still live, so a click on bare track reads as
   * travel rather than a teleport). `dragging` starts on the first move and
   * writes directly, with `data-dragging` switching the transition off so
   * the knob keeps up with the pointer. Setting the drag flag at pointerdown
   * would kill the glide before the browser ever started it: the transition
   * list is read at the next style recalc, by which time the flag is on.
   *
   * The hold spans the whole gesture: the pointer capture keeps the moves
   * coming after it leaves the control, and only the release ends it, so the
   * picker's hover-close — which stands down while `pressed` — hears the
   * button up first (onRelease).
   */
  let pressed = false
  let dragging = false
  let painted = false
  let pointerId: number | null = null
  /** The dash shown when there is no level to name; cached, not re-read per move. */
  let noneLabel = ''
  /** The two name layers, driven by the knob's own travel. */
  const nameSwap = createNameSwap({
    root,
    value: valueEl,
    preview: valuePreview,
    steps: () => steps,
    selected: () => selected,
    none: () => noneLabel,
  })
  /** Whether the top-rung treatment (the matrix) is on. */
  let apexOn = false
  /** The track width the ticks were laid out for, so a late layout re-does them. */
  let ticksWidth = -1
  /**
   * The level just committed, and whether the host has echoed it back yet.
   * The host's catalog snapshot TRAILS the commit — its selection RPC is
   * slow (seconds, on some providers) — so between the release and the echo
   * the snapshot still names the OLD level. Following it there would drag
   * the knob back to where the gesture started, then forward again once the
   * echo lands: the "bounce" on release. While this flag is set, update()
   * keeps the knob on the committed level; the echo (or the safety timeout,
   * for a commit that never lands) ends the wait.
   */
  let pendingEcho = false
  let pendingId: string | undefined = undefined
  let pendingTimer = 0
  /** Longest a commit waits for its echo before the host is trusted again.
      Host selections have been measured at up to ~8s on slow providers. */
  const PENDING_ECHO_MS = 12000

  /**
   * The ladder as ordered steps, the step in force, and the words. A model
   * with no reasoning (or one whose catalog entry has not loaded) resolves to
   * an empty ladder: the slider is still shown, it just has nothing to
   * select. The catalog may leave out a default level (`defaultEffort` is
   * undefined) — that "Default" is a real position on the track, so it leads
   * the steps with an undefined id.
   */
  function state(): { steps: EffortStep[], index: number, labels: EffortLabels } {
    const effort = opts.read()
    const ladder = effort === null
      ? { steps: [] as EffortStep[], index: -1 }
      : effortSteps(effort, MODEL_EFFORT_DEFAULT)
    return {
      steps: ladder.steps,
      index: ladder.index,
      labels: {
        label: copy('effortLabel'),
        faster: copy('effortFaster'),
        smarter: copy('effortSmarter'),
        none: MODEL_EFFORT_NONE,
      },
    }
  }

  /** The knob's width and the track's, as the pass's read phase took them for the update in hand. */
  let passBox: EffortTrackBox | null = null

  /** The knob's width and the track's: the pass's reading inside its update, a fresh one anywhere else. */
  function trackBox(): EffortTrackBox {
    return passBox ?? measureTrack()
  }

  /** Read the knob's width and the track's off the layout. */
  function measureTrack(): EffortTrackBox {
    return { size: knob.offsetWidth || 16, width: track.clientWidth }
  }

  /** How wide the knob is, and how far its centre may travel. */
  function geometry() {
    const box = trackBox()
    return { size: box.size, span: Math.max(0, box.width - box.size) }
  }

  /** The knob's x for one level. No levels (or a single one) rest at the end. */
  function positionFor(index: number) {
    const box = geometry()
    if (index < 0 || steps.length < 2) return box.span
    return (index / (steps.length - 1)) * box.span
  }

  /**
   * Move the knob. While the gesture runs this is ONE compositor write:
   * the stylesheet already drops `translate` from the transition for
   * `data-dragging`, so an inline transition dance (and the forced reflow
   * it needs to take effect) would be pure overhead on every pointermove.
   * The inline dance survives only for the rare non-drag instant move (a
   * ladder swap on first paint), where the stylesheet's transition would
   * otherwise animate the jump.
   *
   * The travel goes through the INDIVIDUAL `translate` property, never
   * `transform`: the drag lift is `scale`, and the individual properties
   * compose as translate → scale. Writing the travel into `transform` puts
   * it AFTER the scale in the product, so a 1.1 lift would scale the travel
   * itself (see the stylesheet's note on the knob).
   */
  let lastTravel = ''
  let lastWidth = ''

  function place(x: number, animate: boolean) {
    const px = Math.round(x)
    const value = `${px}px`
    /* The fill runs from the track's left end to the knob's centre (+8 is
       half the 16px knob from the stylesheet) and disappears under the
       opaque knob, so its right end is never seen. An empty ladder selects
       nothing, and nothing stays unfilled. */
    const width = steps.length === 0 ? '0px' : `${px + 8}px`
    /* Same-value guard: update() runs on every scheduler pass, and re-writing
       an unchanged position would run the transition dance's forced reflow
       for nothing — worse, mid-glide it cancels the transition and snaps the
       knob to its end. Only a real change touches the DOM. */
    if (value === lastTravel && width === lastWidth) return
    lastTravel = value
    lastWidth = width
    if (animate || dragging) {
      knob.style.translate = value
      fill.style.width = width
      return
    }
    withoutTransition([knob, fill], () => {
      knob.style.translate = value
      fill.style.width = width
    })
  }

  /** Where the pointer sits along the track, in knob-travel units. */
  function pointerTravel(clientX: number) {
    const box = geometry()
    // The distance the pointer covers, in the pixels the travel is written in;
    // the knob's own size already is (shared/page-zoom.ts).
    const raw = inPagePixels(clientX - track.getBoundingClientRect().left) - box.size / 2
    return Math.max(0, Math.min(box.span, raw))
  }

  /**
   * How strongly the knob resists leaving a stop, as a fraction of the
   * pointer's speed right at the stop. 0 is pure 1:1 tracking; 0.8 makes the
   * knob creep out of a stop at a FIFTH of the pointer's speed (slope
   * 1 - D at t = 0) and then overtake it mid-segment (slope 1 + D at t = ½,
   * i.e. 1.8×) — a detent you can feel. Must stay below 1: the slope
   * `1 - D·cos(2πt)` would reach zero and the travel would stop being
   * monotone, so the knob could jump backwards.
   */
  const DETENT = 0.8
  /**
   * How far the pointer must travel before a press becomes a drag. A click
   * often brings one or two pixels of movement; treating that as a drag would
   * switch the knob's transition off before the press glide has played, and
   * the knob would teleport to the pointer instead of easing to it.
   */
  const DRAG_THRESHOLD_PX = 3

  /**
   * The detent transfer: raw pointer travel → knob travel. Within one
   * segment the knob lags near the ends and catches up in the middle
   * (`t - D·sin(2πt)/2π`), so leaving a stop feels damped while the middle
   * still tracks the pointer. The curve fixes every stop and every midpoint
   * (t = 0, ½, 1 map to themselves) and is monotone, so `nearest()` may keep
   * reading the RAW position: the knob's nearest stop is the pointer's
   * nearest stop either way. Applied on the pointer paths only — settle and
   * the host echo place the knob on a stop, which the curve already fixes.
   */
  function dampTravel(x: number) {
    if (steps.length < 2) return x
    const box = geometry()
    if (box.span === 0) return x
    const seg = box.span / (steps.length - 1)
    const index = Math.floor(x / seg)
    if (index >= steps.length - 1) return x
    const t = (x - index * seg) / seg
    return (index + t - DETENT * Math.sin(2 * Math.PI * t) / (2 * Math.PI)) * seg
  }

  /** The level nearest a travel position: the one a release settles on. */
  function nearest(x: number) {
    if (steps.length === 0) return -1
    if (steps.length === 1) return 0
    const box = geometry()
    const ratio = box.span === 0 ? 0 : x / box.span
    return Math.max(0, Math.min(steps.length - 1, Math.round(ratio * (steps.length - 1))))
  }

  /**
   * The top rung is the slider's showpiece: reaching it (a settled level or
   * a drag's live position alike) swaps the plain fill for the matrix,
   * tints the knob and colours the level's name. Everything hangs off
   * `data-apex`; the guard keeps the attribute writes — which the
   * scheduler's observer sees — to actual transitions.
   */
  function paintApex(at: number) {
    const want = steps.length > 1 && at === steps.length - 1
    if (want === apexOn) return
    if (want && !dotMatrix.ensure()) return
    apexOn = want
    if (want) root.setAttribute('data-apex', '')
    else root.removeAttribute('data-apex')
  }

  /**
   * One tick dot per stop, centred on the stop's resting position. Rebuilt
   * when the ladder changes or the track's width moved out from under the
   * last layout (first paint can run before the picker has its width).
   * The dots carry no state: the fill they share a colour with swallows
   * the passed ones, and the opaque knob swallows the current one.
   */
  function paintTicks() {
    const w = trackBox().width
    if (!w || w === ticksWidth) return
    ticksWidth = w
    while (ticks.firstChild) ticks.removeChild(ticks.firstChild)
    const box = geometry()
    for (let i = 0; i < steps.length; i++) {
      const dot = buildElement('span', 'dsh-claude-effort-tick')
      dot.style.left = `${Math.round(positionFor(i) + box.size / 2)}px`
      ticks.appendChild(dot)
    }
  }

  /**
   * The level's name while the gesture runs, the committed one otherwise. The
   * two layers and their progress live in name-swap.ts; this reads the slider's
   * own travel into them.
   */
  function paintValue() {
    const at = pressed ? live : selected
    nameSwap.paint(at, pressed, dragging, liveTravel, moveDirection, geometry().span)
    paintApex(at)
  }

  function paintAria(labels: EffortLabels) {
    noneLabel = labels.none
    // Same-value guards throughout: update() runs on every scheduler pass,
    // and an identical write here (in particular the aria-label, which is
    // in the observer's attributeFilter) re-schedules the next pass — a
    // self-sustaining one-pass-per-frame loop.
    if (labelEl.textContent !== labels.label) labelEl.textContent = labels.label
    if (fasterEl.textContent !== labels.faster) fasterEl.textContent = labels.faster
    if (smarterEl.textContent !== labels.smarter) smarterEl.textContent = labels.smarter
    setAttributeIfChanged(track, 'aria-label', labels.label)
    if (steps.length === 0) {
      root.setAttribute('data-empty', '')
      track.setAttribute('aria-disabled', 'true')
      track.removeAttribute('aria-valuemin')
      track.removeAttribute('aria-valuemax')
      track.removeAttribute('aria-valuenow')
      track.removeAttribute('aria-valuetext')
      return
    }
    const at = Math.max(0, selected)
    root.removeAttribute('data-empty')
    track.removeAttribute('aria-disabled')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuemax', String(steps.length - 1))
    track.setAttribute('aria-valuenow', String(at))
    track.setAttribute('aria-valuetext', steps[at] ? steps[at].name : '')
  }

  /** Drop the wait for the host's echo (echo seen, ladder changed, or timeout). */
  function clearPending() {
    if (pendingTimer !== 0) {
      clearTimeout(pendingTimer)
      pendingTimer = 0
    }
    pendingEcho = false
    pendingId = undefined
  }

  /** Commit one level, once: the host is told only when the level moved. */
  function commit(index: number) {
    if (index < 0 || index >= steps.length || index === selected) return
    selected = index
    /* Hold the knob here until the host's snapshot agrees (see pendingEcho). */
    pendingEcho = true
    pendingId = steps[index].id
    if (pendingTimer !== 0) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(clearPending, PENDING_ECHO_MS)
    opts.onPick(steps[index].id)
  }

  function releaseCapture() {
    if (pointerId !== null && track.hasPointerCapture(pointerId)) track.releasePointerCapture(pointerId)
    pointerId = null
  }

  /** The gesture ends: the knob lands on the nearest level and commits it. */
  function settle() {
    if (!pressed) return
    if (moveQueued) {
      // Land the still-pending position first, so the release settles on
      // where the pointer actually is rather than one event behind.
      if (cancelPendingFrame !== null) cancelPendingFrame()
      moveQueued = false
      cancelPendingFrame = null
      applyPending()
      if (!pressed) return
    }
    pressed = false
    dragging = false
    root.removeAttribute('data-dragging')
    releaseCapture()
    const index = live
    const previous = selected
    live = -1
    /* Commit FIRST, then paint ONCE on the committed level. Painting before
       the commit read the OLD `selected`: the name went back to the level
       the gesture started from, and the apex attribute flipped off and on,
       which hid the matrix and restarted its entrance sweep — a visible
       double take on every release. */
    commit(index)
    place(positionFor(selected), true)
    paintApex(selected)
    nameSwap.settle(selected, previous)
  }

  /**
   * The physical release, wherever it lands: the pointer may be outside the
   * card when the button comes up, and the picker closes the card there. It
   * is heard on the document — capture phase, so a host handler's
   * stopPropagation cannot steal it — and fires BEFORE the track's
   * bubble-phase pointerup (settle), which is safe: the close it may cause
   * only flips data-open, the commit below proceeds regardless.
   */
  function onRelease(e: PointerEvent) {
    if (e.pointerId !== pointerId) return
    document.removeEventListener('pointerup', onRelease, true)
    document.removeEventListener('pointercancel', onRelease, true)
    if (typeof opts.onDragEnd === 'function') opts.onDragEnd(e)
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    painted = true
    pointerId = e.pointerId
    document.addEventListener('pointerup', onRelease, true)
    document.addEventListener('pointercancel', onRelease, true)
    track.setPointerCapture(e.pointerId)
    if (typeof opts.onDragStart === 'function') opts.onDragStart()
    // A pending settle no longer owns the words: this gesture does.
    nameSwap.reset()
    const x = pointerTravel(e.clientX)
    /* Glide to the press position. The drag state (and with it the
       transition-off flag) only starts on the first MOVE — see the flags'
       note: setting it here would suppress the very transition that makes
       this read as travel. */
    pressed = true
    downX = e.clientX
    liveTravel = dampTravel(x)
    const delta = liveTravel - positionFor(selected)
    moveDirection = Math.abs(delta) < 0.5 ? 0 : Math.sign(delta)
    place(liveTravel, true)
    live = nearest(x)
    paintValue()
  }

  /**
   * The gesture's latest pointer position. pointermove fires faster than
   * frames render; the event stores the position and ONE animation-frame
   * callback applies it — reads the travel geometry first, writes after (one
   * transform + the level name) — so the drag costs one layout flush per
   * frame instead of one forced reflow per event.
   */
  let cancelPendingFrame: (() => void) | null = null
  let moveQueued = false
  let pendingX = 0
  /** Where the press landed, so a click's incidental movement is not a drag. */
  let downX = 0

  function applyPending() {
    if (!pressed) return
    // The pointer may run past either end or off the control with the button
    // down: the travel clamps to the track and the gesture goes on, so an end
    // stop stays reachable — ending it at the control's edge left the reader
    // unable to drag back off that stop.
    const x = pointerTravel(pendingX)
    const travel = dampTravel(x)
    const delta = travel - liveTravel
    if (Math.abs(delta) > 0.1) moveDirection = Math.sign(delta)
    liveTravel = travel
    // Until the press has actually become a drag, the knob keeps the press
    // glide's transition: a click's one-pixel move must not snap it.
    place(travel, !dragging)
    live = nearest(x)
    paintValue()
  }

  function onPointerMove(e: PointerEvent) {
    if (!pressed) return
    if (!dragging && Math.abs(inPagePixels(e.clientX - downX)) >= DRAG_THRESHOLD_PX) {
      // The pointer has left the click's tolerance: the knob must follow it
      // without easing.
      dragging = true
      root.setAttribute('data-dragging', '')
    }
    pendingX = e.clientX
    if (moveQueued) return
    moveQueued = true
    cancelPendingFrame = requestFrame({
      write() {
        moveQueued = false
        cancelPendingFrame = null
        applyPending()
      },
    })
  }

  track.addEventListener('pointerdown', onPointerDown)
  track.addEventListener('pointermove', onPointerMove)
  track.addEventListener('pointerup', () => { settle() })
  track.addEventListener('pointercancel', () => { settle() })
  track.addEventListener('keydown', e => {
    if (steps.length === 0) return
    const base = selected < 0 ? 0 : selected
    let next = base
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, base - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(steps.length - 1, base + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = steps.length - 1
    else return
    e.preventDefault()
    e.stopPropagation()
    const previous = selected
    commit(next)
    place(positionFor(next), true)
    paintAria(state().labels)
    paintApex(selected)
    nameSwap.start(previous, selected)
  })

  /**
   * Re-point the control at the model in force. The ladder is rebuilt only
   * when the levels themselves change; the knob is only animated when the
   * selected level moved on its own (the host echoing a selection back).
   *
   * @param box - the track's reading from the pass's read phase (D40): the
   *   card keeps its layout box while closed, so a read here, after the pass's
   *   writes, would force a layout on every pass. Left out, the update reads
   *   the layout itself.
   */
  function update(box?: EffortTrackBox | null) {
    passBox = box ?? null
    const next = state()
    let changed = next.steps.length !== steps.length
    if (!changed) {
      for (let i = 0; i < next.steps.length; i++) {
        if (next.steps[i].id !== steps[i].id) { changed = true; break }
      }
    }
    if (changed) {
      steps = next.steps.slice()
      ticksWidth = -1
      /* A different ladder is a different question; the old commit's echo
         will never come. */
      clearPending()
    }
    /* The echo test: the snapshot now names the level we committed. */
    if (pendingEcho && next.index >= 0 && next.steps[next.index] !== undefined && next.steps[next.index].id === pendingId) {
      clearPending()
    }
    let swapFrom = -1
    if (!pressed && !pendingEcho) {
      const moved = painted && !changed && selected !== next.index
      swapFrom = moved ? selected : -1
      selected = next.index
      place(positionFor(selected), moved)
      painted = true
    }
    paintTicks()
    // A drag or a key between passes reads the layout it acts on.
    passBox = null
    paintAria(next.labels)
    if (swapFrom >= 0) {
      paintApex(selected)
      nameSwap.start(swapFrom, selected)
    } else {
      paintValue()
    }
  }

  return {
    el: root,
    update,
    measure: measureTrack,
    // The picker's hover-close guard keys on the hold, from pointerdown
    // until the release wherever it lands: a gesture that travels out of the
    // card keeps it open, and the release outside closes it (onDragEnd).
    isHeld() { return pressed },
    /**
     * The control's own teardown. The listeners a hold put on the document,
     * the frame a pending move waits on and the wait for the host's echo all
     * outlive the card they serve, so the picker calls this when it drops the
     * slider rather than letting the removal of the node drop them.
     */
    dispose() {
      dotMatrix.dispose()
      document.removeEventListener('pointerup', onRelease, true)
      document.removeEventListener('pointercancel', onRelease, true)
      if (cancelPendingFrame !== null) cancelPendingFrame()
      cancelPendingFrame = null
      nameSwap.dispose()
      moveQueued = false
      releaseCapture()
      clearPending()
    },
  }
}
