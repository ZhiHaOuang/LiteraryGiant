import { subscribeMutations } from './bus'

/**
 * The host's floating layer in a page the skin draws at a scale (D43, D81).
 *
 * The skin draws the page at the reader's own scale by putting `zoom` on the
 * body (packages/client/src/theme/chrome.css, docs/STYLE.md). A box laid out
 * inside that scaling is drawn at the scale, and a length written into it is
 * read through the same scale again: a host card that measures a row in the
 * viewport's pixels and writes that box whole comes out at the square of the
 * scale. Worse, the host measures its own card in the page's pixels while it
 * measures the row it hangs from in the viewport's, so a card placed from its
 * own height — a menu opening over its trigger — lands short of it by the
 * height's share of the scale.
 *
 * Both come from one cause: the host writes its placement for a box that is one
 * pixel to one pixel with the window. What is given back here is that box, and
 * only to the host's own floating cards: the card's own space is drawn at the
 * page's scale divided out again, so a length the host writes and a box the host
 * measures are the same length on screen.
 *
 * The skin's own cards are placed by the skin, which reads the scale itself
 * (packages/client/src/shared/page-zoom.ts), and are left alone.
 */

/** What this mechanism needs from the skin it serves (D73). */
export interface PageScaleVocabulary {
  /** Whether a node belongs to the skin's own floating layer. */
  isOwn(node: Element): boolean
  /** The scale the page is drawn at right now: 1 while the page is not scaled. */
  scale(): number
  /**
   * A scale change was read; set the page's own readings straight. Called from
   * the child observer the update walks, so it must not write the body's children.
   */
  onChange?(): void
  /** Every card is handed back; the readings of the page in hand wait to be read again. */
  onRelease?(): void
}

/** The scale one card's own space is drawn at: the page's scale taken out again. */
export function counterScale(scale: number) {
  if (!(scale > 0) || scale === 1) return 1
  // Rounded: the number goes into a style string the mechanism compares itself
  // against on every pass, and a longer fraction would only lengthen it.
  return Math.round(1e6 / scale) / 1e6
}

/**
 * Give the host's floating cards their own one-to-one space, and take it back on
 * the teardown.
 *
 * Only a body-level node the host gave its own `left` and `top` and a floating
 * position is given the space: a card positioned by the host's stylesheet is
 * read at the page's scale once, the way everything else on the page is, and
 * needs nothing. Every other body-level node is heard anyway, because a card the
 * host mounts before it knows where it goes takes its `left` and `top` a moment
 * later.
 *
 * @returns settle: read every card again, for a scale that changed under them;
 *     stop: give every card back.
 */
export function installScaledLayer(vocabulary: PageScaleVocabulary) {
  /** The body-level nodes being heard, each with the subscription that hears it. */
  const heard = new Map<HTMLElement, () => void>()
  /** The cards this mechanism has written to, so the teardown hands each one back as it was. */
  const written = new Set<HTMLElement>()

  /** Give one card the page's own space back. A card never carried is left untouched. */
  const hand = (card: HTMLElement) => {
    if (!written.delete(card)) return
    card.style.removeProperty('zoom')
  }

  /** Whether this node is one of the host's own floating cards. */
  const isFloatingCard = (node: Element): node is HTMLElement => {
    if (!(node instanceof HTMLElement) || vocabulary.isOwn(node)) return false
    // Read before the computed style: a card the host positioned itself is the
    // only one that mixes the two spaces, and this test costs no style pass.
    if (node.style.left === '' || node.style.top === '') return false
    const position = getComputedStyle(node).position
    return position === 'fixed' || position === 'absolute'
  }

  /** Bring one body-level node in line: carry it, or hand it back when it stops being a card. */
  const carry = (node: HTMLElement) => {
    if (!isFloatingCard(node)) {
      hand(node)
      return
    }
    const value = String(counterScale(vocabulary.scale()))
    if (value === '1') {
      hand(node)
      return
    }
    if (node.style.zoom === value) return
    node.style.zoom = value
    written.add(node)
  }

  /** Hear every body-level node the skin does not own, and drop the ones that left. */
  const sync = () => {
    const present = new Set<HTMLElement>()
    for (const child of document.body.children) {
      if (!(child instanceof HTMLElement) || vocabulary.isOwn(child)) continue
      present.add(child)
      if (!heard.has(child)) {
        heard.set(child, subscribeMutations(child, { attributes: true, attributeFilter: ['style'] }, () => carry(child)))
      }
      carry(child)
    }
    for (const [node, off] of [...heard]) {
      if (present.has(node)) continue
      heard.delete(node)
      off()
      written.delete(node)
    }
  }

  const stopWatch = subscribeMutations(document.body, { childList: true }, () => {
    sync()
    vocabulary.onChange?.()
  })
  sync()

  return {
    settle: sync,
    stop() {
      stopWatch()
      for (const [node, off] of heard) {
        off()
        hand(node)
      }
      heard.clear()
      vocabulary.onRelease?.()
    },
  }
}
