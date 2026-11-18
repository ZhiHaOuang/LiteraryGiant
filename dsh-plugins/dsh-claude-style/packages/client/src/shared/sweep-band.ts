import { buildElement } from '@dsh-claude-style/engine/dom'

/**
 * The highlight band the host's own TextShimmer draws over a running row's
 * words (dsh-client-ui-primitives), built the same way: a window carrying the
 * band's mask and, inside it, a copy of the words in the shimmer tint. The two
 * cross the box in opposite directions by the same distance, so the copy's
 * glyphs stand exactly over the words while the mask moves; both halves are
 * transforms the compositor plays on its own (shared/motion.css). The band is
 * decoration — the owner's words are what a reader hears and selects — so it
 * is hidden from the reader's tree and takes no input.
 */

/** The window: the band's mask, laid over its owner's box (shared/motion.css). */
export const SWEEP_BAND_CLASS = 'dsh-claude-sweep-band'
/** The tinted copy inside the window, crossing back. */
export const SWEEP_GLYPHS_CLASS = 'dsh-claude-sweep-glyphs'

/**
 * Build one band.
 *
 * @param text - a one-line owner's words, generated from `data-text` so they
 *     are written once in the document; null for an owner that fills the copy
 *     with its own markup.
 * @returns the window to lay over the owner, and the copy inside it.
 */
export function buildSweepBand(text: string | null) {
  const band = buildElement('span', SWEEP_BAND_CLASS)
  band.setAttribute('aria-hidden', 'true')
  band.inert = true
  const glyphs = buildElement('span', SWEEP_GLYPHS_CLASS)
  if (text !== null) glyphs.setAttribute('data-text', text)
  band.appendChild(glyphs)
  return { band, glyphs }
}
