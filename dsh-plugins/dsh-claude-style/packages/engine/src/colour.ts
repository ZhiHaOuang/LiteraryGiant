/**
 * A colour as channels, in the form the skin can paint with.
 *
 * A computed colour reaches the skin in the form its table states: `rgb()` from
 * the host's own rules, a literal from a card's token, or the relative colour a
 * reader's palette derives from their canvas (D30). Painting one pixel is where
 * every one of those forms comes out the same way.
 */
export interface PaintedColour {
  readonly red: number
  readonly green: number
  readonly blue: number
  /** The fill's own alpha, 0–1. */
  readonly alpha: number
}

/** The canvas every read shares: the page's own are busy drawing, and one created per call would be thrown away. */
let scratch: CanvasRenderingContext2D | null = null

function scratchContext() {
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (scratch === null) throw new Error('colour: the scratch canvas has no 2d context')
  return scratch
}

/**
 * Paint a CSS colour on one pixel and read it back.
 *
 * The pixel starts see-through, because a value the canvas cannot paint leaves
 * `fillStyle` as it was: that turns the refusal into an empty pixel instead of
 * the colour the previous read left behind. Null is that empty pixel — a value
 * the page states but no browser can resolve, which is a mistake in the rule
 * that stated it.
 */
export function resolveColour(value: string, context: CanvasRenderingContext2D = scratchContext()): PaintedColour | null {
  context.fillStyle = 'rgba(0, 0, 0, 0)'
  context.fillStyle = value
  context.clearRect(0, 0, 1, 1)
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  return alpha === 0 ? null : { red, green, blue, alpha: alpha / 255 }
}
