import { SLOT_NODE_ATTR } from '../../constants'

/**
 * The box the composer's two seat texts share: the model's name and the effort
 * level's. It holds one part per decision, each its own hover plate, so a
 * pointer over the model's name leaves the level's plate alone and the two
 * cards keep their own hit areas.
 *
 * The host's own seat is one button carrying both texts; the skin needs two hit
 * areas — the model list and the effort card are two decisions with two cards —
 * and a button cannot hold a button. The box is the skin's own node inside the
 * host's slot, and the row lays it out as one item against its right end, which
 * is what lets both cards hang from that edge.
 */
export const SEAT_BOX_CLASS = 'dsh-claude-model-seat'
/** One decision's own part inside the box, and its hover plate. */
export const SEAT_MODEL_CLASS = 'dsh-claude-model-seat-model'
export const SEAT_EFFORT_CLASS = 'dsh-claude-model-seat-effort'
export type SeatPart = 'model' | 'effort'

const PART_CLASS: Readonly<Record<SeatPart, string>> = Object.freeze({
  model: SEAT_MODEL_CLASS,
  effort: SEAT_EFFORT_CLASS,
})

/** One part of the box, created on demand for a box an older generation left behind. */
export function ensureSeatPart(box: HTMLElement, part: SeatPart): HTMLElement {
  const existing = box.querySelector<HTMLElement>(`:scope > .${PART_CLASS[part]}`)
  if (existing !== null) return existing
  const node = document.createElement('div')
  node.className = PART_CLASS[part]
  box.appendChild(node)
  return node
}

/** The seat box already in the slot, or a fresh one appended to it. */
export function ensureSeatBox(slot: HTMLElement, current: HTMLElement | null): HTMLElement {
  const box = current !== null && current.parentElement === slot ? current : document.createElement('div')
  if (box !== current) {
    if (current !== null && current.parentElement !== null) current.parentElement.removeChild(current)
    box.className = SEAT_BOX_CLASS
    // The slot holds the host's root and the skin's own nodes: the reader that
    // finds the host's root skips everything carrying this mark.
    box.setAttribute(SLOT_NODE_ATTR, '')
    slot.appendChild(box)
  }
  ensureSeatPart(box, 'model')
  ensureSeatPart(box, 'effort')
  return box
}
