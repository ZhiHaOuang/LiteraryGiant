import { inPageBox } from './page-zoom'

/**
 * The box a container's content covers: the union of its own element children's
 * boxes, in the pixels the page's styles read.
 *
 * A container the host measures can be laid out wider than what it draws — the
 * conversation's view-tab row spans the header so the host counts room for every
 * tab, while the strip the reader sees is the plate and the overflow button
 * standing in it — so a placement that reasons about the visible strip asks for
 * this box rather than the container's own (features/view-tabs,
 * features/header-band).
 *
 * @param container - the element whose children are what it draws.
 * @returns the union of the children's boxes, or the container's own box when it
 *   draws no child; null when the box has no extent.
 */
export function contentBox(container: Element) {
  let box: DOMRect | null = null
  for (const child of container.children) {
    const childBox = inPageBox(child.getBoundingClientRect())
    if (childBox.width === 0 && childBox.height === 0) continue
    box = box === null ? childBox : new DOMRect(
      Math.min(box.left, childBox.left),
      Math.min(box.top, childBox.top),
      Math.max(box.right, childBox.right) - Math.min(box.left, childBox.left),
      Math.max(box.bottom, childBox.bottom) - Math.min(box.top, childBox.top),
    )
  }
  if (box !== null) return box
  const own = inPageBox(container.getBoundingClientRect())
  return own.width === 0 && own.height === 0 ? null : own
}
