/**
 * The account row's menu opens over the row at the page's own scale and under
 * the reader's page zoom alike. The host places its own card from the row's
 * bounding box and the card's laid-out height, and the two are measured in
 * different pixels once the page is drawn at a zoom factor.
 *
 * @capability account-menu
 * @features account
 * @risk With the page drawn at a zoom factor the account menu opens below its row and runs past the window's edge, so the settings and sign-out rows cannot be reached.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** The host's account row: the button the host names. */
const accountRow = (page) => page.locator('#host-account')

/** The card's own box while it stands. */
async function cardBox(t) {
  return t.page.evaluate((selector) => {
    const card = document.querySelector(selector)
    if (card === null) return null
    const box = card.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
  }, t.surface('account.menu'))
}

/** The window's own size. */
async function windowBox(t) {
  return t.page.evaluate(() => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight }))
}

/**
 * The card is not on the row: its bottom edge stands above the row's top edge.
 * The row is read after the card is open — a press on it changes the page — and
 * Playwright's own hit testing is what reads it, the row being covered by the
 * card rather than merely overlapped.
 */
async function aboveTheRow(t) {
  const card = await cardBox(t)
  t.expectThat.visible(card, 'the account menu is drawn')
  const row = await accountRow(t.page).boundingBox()
  t.expectThat.equal(row !== null && card.bottom <= row.y, true,
    `the menu opens over its row (card bottom ${card.bottom.toFixed(1)}, row top ${row === null ? 'none' : row.y.toFixed(1)})`)
}

/**
 * The card opens upward from its row: its top edge stands above the row and its
 * bottom edge does not run past the row's. A card taller than the room above
 * the row is held against the window's top edge and covers the row by the least
 * it can — the zoomed card on a short window, with a platform's taller fonts, is
 * one — so this is the reading the zoom is judged on.
 */
async function upwardFromTheRow(t) {
  const card = await cardBox(t)
  t.expectThat.visible(card, 'the account menu is drawn')
  const row = await accountRow(t.page).boundingBox()
  t.expectThat.equal(row !== null && card.top < row.y && card.bottom <= row.y + row.height, true,
    `the menu opens upward from its row (card ${card.top.toFixed(1)}–${card.bottom.toFixed(1)}, row ${row === null ? 'none' : `${row.y.toFixed(1)}–${(row.y + row.height).toFixed(1)}`})`)
}

/**
 * Open the row's menu and wait for the card itself, not a fixed slice of time:
 * the entrance transition settles once the card is mounted, and a platform that
 * mounts it later is still the same page.
 */
async function openMenu(t) {
  await accountRow(t.page).click()
  await t.page.waitForFunction(selector => document.querySelector(selector) !== null, t.surface('account.menu'), { timeout: 10000 })
  await t.settle()
}

export default spec({ page: 'desktop' }, ({ test }) => {
  test('the account menu opens above its row', async (t) => {
    await openMenu(t)
    await aboveTheRow(t)
    t.expectThat.boxWithin(await cardBox(t), await windowBox(t), 'the menu stays inside the window at the page\'s own scale', 1)
  })

  test('under page zoom the menu still opens upward from its row, inside the window', async (t) => {
    await t.prefs({ pageZoom: '1.25' })
    // The zoom is what this reading is about, so it is judged too: a preference
    // that never reached the page would leave the placement at 100% and the
    // comparison would pass over a state nothing exercised.
    t.expectThat.equal(await t.read.attribute('body', t.surface.attribute('skin.page-zoom')), '1.25', 'the page is drawn at 125%')
    await openMenu(t)
    await upwardFromTheRow(t)
    t.expectThat.boxWithin(await cardBox(t), await windowBox(t), 'the menu stays inside the window at 125%', 1)
  })
})
