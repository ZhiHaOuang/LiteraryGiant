/**
 * The page's narrow layouts follow the page's own width, which the page zoom
 * divides the window by: a page zoomed in gives up the number beside the
 * context ring once its own width is a phone's, and a page zoomed out keeps the
 * number on a phone-sized window it has room in.
 *
 * @capability context-stats
 * @features context-stats
 * @risk With the page zoomed, the composer row keeps its wide layout in a page as narrow as a phone's and crowds its controls, or gives up the number in a page that has room for it.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** The page's own width under the phone layout, in the page's own pixels. */
const PHONE_WIDTH = 480

/** Whether the number beside the ring is drawn, and the page's own width. */
const readRow = (t) => t.page.evaluate(([ringSelector, zoomAttr]) => {
  const ring = document.querySelector(ringSelector)
  const value = ring === null ? null : ring.querySelector('button > span')
  const zoom = Number.parseFloat(document.body.getAttribute(zoomAttr) ?? '1')
  return { valueShown: value !== null && value.getClientRects().length > 0, pageWidth: innerWidth / zoom }
}, [t.surface('stats.meter-ring'), t.surface.attribute('skin.page-zoom')])

export default spec({ page: 'context-stats', bands: ['phone', 'compact'] }, ({ test }) => {
  for (const zoom of ['0.8', '1.5']) {
    test(`at a page zoom of ${zoom} the number beside the ring follows the page's own width`, async (t) => {
      await t.prefs({ pageZoom: zoom })
      t.expectThat.equal(await t.read.attribute('body', t.surface.attribute('skin.page-zoom')), zoom, `the page is drawn at ${zoom}`)
      const row = await readRow(t)
      const narrow = row.pageWidth <= PHONE_WIDTH
      t.expectThat.equal(row.valueShown, !narrow,
        `${narrow ? 'the number is given up' : 'the number is drawn'} in a page ${Math.round(row.pageWidth)}px wide`)
    })
  }
})
