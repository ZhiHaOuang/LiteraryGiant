import { requestFrame } from '@dsh-claude-style/engine/frame'
import { motionMs } from '../../shared/motion'
import { paintEffortTint } from './tint'
import type { EffortStep } from './ladder'

/**
 * The effort slider's level name as two layers whose progress is the knob's
 * own travel: the value holds the words on show, the preview the words the
 * knob is travelling toward. Moving toward stronger sends the old name up and
 * the new one up from below; moving back toward weaker runs both layers the
 * other way, so the words rewind with the knob instead of replaying upward.
 *
 * The slider writes the progress while a drag runs. On a release, a jump
 * between stops or the host's echo, the stylesheet's move transition carries
 * the layers home over the same duration as the knob; the preview then becomes
 * the value without moving a pixel.
 */
export interface NameSwapOptions {
  root: HTMLElement
  value: HTMLElement
  preview: HTMLElement
  steps: () => readonly EffortStep[]
  selected: () => number
  none: () => string
}

/** One rung's name, or the dash when there is no rung. */
function nameAt(index: number, steps: readonly EffortStep[], none: string) {
  return index >= 0 && steps[index] ? steps[index].name : none
}

export function createNameSwap(opts: NameSwapOptions) {
  let base = -1
  let target = -1
  let progress = 0
  let normaliseAtEnd = false
  let normaliseTimer = 0
  let frame: (() => void) | null = null

  /** Write the two layers and the share of the segment between them. */
  function write(nextBase: number, nextTarget: number, share: number) {
    const q = Math.max(0, Math.min(1, share))
    const steps = opts.steps()
    const baseText = nameAt(nextBase, steps, opts.none())
    const targetText = nameAt(nextTarget, steps, opts.none())
    let anchored = false
    if (opts.value.textContent !== baseText) {
      opts.value.textContent = baseText
      anchored = true
    }
    if (opts.preview.textContent !== targetText) {
      opts.preview.textContent = targetText
      anchored = true
    }
    // The preview sits exactly over the value; offsetLeft is against the
    // positioned head. Read only when a name changed, never per pointer frame.
    if (anchored) opts.preview.style.left = `${opts.value.offsetLeft}px`
    opts.root.style.setProperty('--dsh-claude-effort-swap-progress', String(q))
    opts.root.style.setProperty('--dsh-claude-effort-swap-rest', String(1 - q))
    opts.root.style.setProperty('--dsh-claude-effort-swap-dir', nextTarget >= nextBase ? '1' : '-1')
    base = nextBase
    target = nextTarget
    progress = q
    paintEffortTint(opts.root, steps, nextTarget >= 0 ? nextTarget : nextBase)
  }

  /**
   * Put the value at rest in one frame. The preview and the value hold the same
   * words at the same pixels here; letting their transitions run would fade
   * that one name in against itself, which reads as a weak extra animation
   * after the switch.
   */
  function writeAtRest(at: number) {
    opts.root.setAttribute('data-dsh-claude-effort-swap-reset', '')
    write(at, at, 0)
    void opts.preview.offsetWidth
    opts.root.removeAttribute('data-dsh-claude-effort-swap-reset')
  }

  /** Drop a finished swap into the rung in force, without moving a pixel. */
  function normalise() {
    if (normaliseTimer !== 0) {
      clearTimeout(normaliseTimer)
      normaliseTimer = 0
    }
    normaliseAtEnd = false
    writeAtRest(opts.selected())
  }

  /** A fallback for a transition the browser coalesced away; the event alone is not guaranteed. */
  function scheduleNormalise() {
    if (normaliseTimer !== 0) clearTimeout(normaliseTimer)
    normaliseTimer = setTimeout(() => {
      normaliseTimer = 0
      normalise()
    }, motionMs('--dsh-claude-duration-move') + 16)
  }

  /**
   * The pair of stops around the knob's travel. Moving toward stronger names
   * the lower stop as the base and the upper as the target; moving toward
   * weaker names them the other way round.
   */
  function pair(travel: number, direction: number, span: number) {
    const steps = opts.steps()
    const max = steps.length - 1
    if (max <= 0) return { base: max, target: max, progress: 0 }
    const position = span === 0 ? 0 : Math.max(0, Math.min(max, (travel / span) * max))
    if (direction > 0) {
      if (position >= max) return { base: max, target: max, progress: 0 }
      const from = Math.floor(position)
      return { base: from, target: Math.min(max, from + 1), progress: position - from }
    }
    if (direction < 0) {
      if (position <= 0) return { base: 0, target: 0, progress: 0 }
      const to = Math.floor(position)
      return { base: Math.min(max, to + 1), target: to, progress: 1 - (position - to) }
    }
    const at = opts.selected()
    return { base: at, target: at, progress: 0 }
  }

  function clearFrame() {
    if (frame !== null) frame()
    frame = null
  }

  function cancelPending() {
    clearFrame()
    if (normaliseTimer !== 0) {
      clearTimeout(normaliseTimer)
      normaliseTimer = 0
    }
  }

  /**
   * Paint the name for one slider state. While the drag runs the pair comes
   * from the travel; at rest it is the selected rung. A completed swap waits
   * for its transition to finish before it is folded into the value.
   */
  function paint(at: number, pressed: boolean, dragging: boolean, travel: number, direction: number, span: number) {
    if (!pressed && normaliseAtEnd) return
    if (pressed && dragging) {
      const steps = pair(travel, direction, span)
      write(steps.base, steps.target, steps.progress)
      return
    }
    const still = pressed ? opts.selected() : at
    write(still, still, 0)
  }

  /**
   * Animate a jump between two selected rungs, as a keyboard press or the
   * host's echo makes. The direction is landed at progress 0 with transitions
   * off, so the preview starts on the side the travel comes from.
   */
  function start(from: number, to: number) {
    if (from < 0 || to < 0 || from === to) {
      normalise()
      return
    }
    cancelPending()
    opts.root.setAttribute('data-dsh-claude-effort-swap-reset', '')
    normaliseAtEnd = true
    write(from, to, 0)
    void opts.preview.offsetWidth
    opts.root.removeAttribute('data-dsh-claude-effort-swap-reset')
    frame = requestFrame({
      write() {
        frame = null
        if (!normaliseAtEnd || base !== from || target !== to) return
        write(from, to, 1)
        scheduleNormalise()
      },
    })
  }

  /**
   * Let the release carry the swap to the committed stop over the stylesheet's
   * move transition. When the target is the incoming rung, the preview becomes
   * the value after that transition; when the knob snaps back, the value simply
   * returns to full strength.
   */
  function settle(selected: number, previous: number) {
    cancelPending()
    if (base >= 0 && target >= 0 && base !== target && (selected === base || selected === target)) {
      if (selected === target) {
        normaliseAtEnd = true
        write(base, target, 1)
        scheduleNormalise()
      } else {
        normaliseAtEnd = false
        write(base, target, 0)
      }
      return
    }
    if (selected !== previous) {
      start(previous, selected)
      return
    }
    normalise()
  }

  /** Cancel any pending settle so a new gesture owns the words. */
  function reset() {
    cancelPending()
    normaliseAtEnd = false
    writeAtRest(opts.selected())
  }

  /** The preview's transition ended: fold it into the value at the same pixels. */
  function onTransitionEnd(event: TransitionEvent) {
    if (!normaliseAtEnd || event.propertyName !== 'opacity' || progress < 1) return
    normalise()
  }
  opts.preview.addEventListener('transitionend', onTransitionEnd)

  return {
    paint,
    start,
    settle,
    reset,
    normalise,
    /** Whether a release's transition still owns the words. */
    settling() { return normaliseAtEnd },
    dispose() {
      cancelPending()
      normaliseAtEnd = false
      opts.preview.removeEventListener('transitionend', onTransitionEnd)
    },
  }
}
