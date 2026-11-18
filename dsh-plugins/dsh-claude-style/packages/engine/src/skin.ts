/**
 * The seam between the engine and the skin it serves (D73).
 *
 * The engine talks to the host's page: it watches it, it schedules frames, it
 * reads and moves host elements. Two of the things it needs are the skin's own
 * — the attribute vocabulary the skin writes and the answers only the skin can
 * give — so the skin hands them over once, before anything installs. The engine
 * never guesses one: a part asked before the hand-over throws rather than
 * reading a default that would quietly watch the wrong nodes.
 */

/** What the engine needs from the skin it serves. */
export interface SkinSeam {
  /** The package the skin ships as: what a console line names it by. */
  packageName: string
  /**
   * The attribute on a node the skin owns purely for its own bookkeeping: a
   * change to such a node is not a page change and wakes no subscriber.
   */
  quiet: string
  /**
   * The attribute a container carries while the reader has taken its scrolling
   * over, until he comes back to its end.
   */
  readerHold: string
  /** Whether the skin must hold its animations still right now. */
  motionReduced(): boolean
}

let current: SkinSeam | null = null

/**
 * Hand the engine the skin's own vocabulary and answers. The entry calls this
 * before the first engine part installs; a second call replaces the seam.
 */
export function adoptSkin(seam: SkinSeam) {
  current = seam
}

/** The seam, or a refusal: an engine part running before the hand-over is a wiring mistake. */
export function skin(): SkinSeam {
  if (current === null) throw new Error('dsh-claude-style engine: the skin handed its vocabulary over after an engine part asked for it')
  return current
}
