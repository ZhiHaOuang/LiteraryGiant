import { observeSize, subscribeMutations } from '@dsh-claude-style/engine/bus'
import { positionAnchoredPopover } from '../../shared/popover'

/**
 * Where the host's own account card stands.
 *
 * The host portals its card to body, mounts it `position: fixed` and puts it
 * above the trigger from the trigger's box and the card's laid-out height. The
 * box comes back in the window's pixels while the card's `top` and its height
 * are read in body's — and body is the box the page's zoom draws
 * (theme/chrome.css). The host subtracts a height in one space from a position
 * in the other, so at any factor other than one the card lands below the row
 * and past the window's edge (issue #91). This answers the geometry the host
 * meant, computed in the card's own space: the shared anchoring reads the
 * trigger and the window at the page's scale and the card at its layout height
 * — above the row and left-aligned with it, or beside it while the sidebar is a
 * rail, the way the self-built drawer sits.
 *
 * The declarations are `important` inline because the host keeps writing its own
 * placement as plain inline styles on later frames; the watch puts the answer
 * back over each of those writes, before the frame paints. The host also
 * re-places the card whenever it changes size — it grows when the skin's rows
 * land in it — so the size callback follows the host's own in the frame
 * (`afterHost`), and reads the size the host has just placed for.
 */
export function createHostMenuPlacement(options: { trigger(): HTMLElement | null }) {
  /** The air the host leaves between the account row and the card above it. */
  const GAP = 4
  /** Takes down the watch on the open card, while one is up. */
  let stopWatching: (() => void) | null = null

  /** The sidebar collapsed into its rail, where a card opens beside the row. */
  function inRail(element: Element) {
    return element.closest('[data-dsh-claude-part~="sidebar-collapsed"]') !== null
  }

  /** Put the card where the host meant it. */
  function place(menu: HTMLElement) {
    const trigger = options.trigger()
    if (trigger === null || menu.offsetWidth === 0 || menu.offsetHeight === 0) return
    positionAnchoredPopover(trigger, menu, inRail(trigger)
      ? { side: 'right', important: true }
      : { side: 'above-left', gap: GAP, important: true })
  }

  function unwatch() {
    if (stopWatching === null) return
    stopWatching()
    stopWatching = null
  }

  /**
   * Follow an open card while it stands: its style writes, and its size. The
   * same-value guard in positionAnchoredPopover is what keeps the skin's own
   * write from reporting back to the style watch.
   */
  function watch(menu: HTMLElement) {
    unwatch()
    const stopStyle = subscribeMutations(menu, { attributes: true, attributeFilter: ['style'] }, () => place(menu))
    const stopSize = observeSize(menu, () => place(menu), { afterHost: true })
    stopWatching = () => {
      stopStyle()
      stopSize()
    }
  }

  return { place, watch, unwatch }
}
