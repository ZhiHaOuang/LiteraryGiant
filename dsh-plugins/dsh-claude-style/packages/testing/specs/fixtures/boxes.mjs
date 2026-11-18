/**
 * A Playwright box in the readers' shape: the four edges and the two sizes,
 * which is what the predicates judge. Playwright answers `{ x, y, width,
 * height }`, and both behaviour specs that read a control's box through
 * Playwright take it from here.
 */
async function boxOf(locator) {
  const box = await locator.boundingBox()
  return box === null ? null : { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, width: box.width, height: box.height }
}

export { boxOf }
