/**
 * At a page zoom the page the skin draws is the window: the body takes the
 * window's own size in the page's pixels, and a box that reaches past it leaves
 * no scroll band under the shell.
 *
 * @capability page-scale
 * @features core
 * @risk At a page zoom the window scrolls past the shell through an empty band, or the shell itself is drawn a factor larger than the window.
 * @risk At a page zoom the document's own margins are drawn through the scale, and the page scrolls sideways past the window at a factor the reader chose.
 */
import { spec, surface } from '../../fixtures/behaviour.mjs'

const ZOOM = surface.attribute('skin.page-zoom')

/** The window, the body's drawn box and the room the scrollbar takes. */
const read = (t) => t.page.evaluate(() => {
  const body = document.body.getBoundingClientRect()
  const root = document.documentElement
  return {
    inner: [innerWidth, innerHeight],
    body: [body.width, body.height],
    scrollbar: innerWidth - root.clientWidth,
    // The document's own size: what the window scrolls to, margins and floats
    // included, over the room the window gives it.
    document: [root.scrollWidth, root.scrollHeight],
    room: [root.clientWidth, root.clientHeight],
    bodyRight: body.right,
    bodyMargin: getComputedStyle(document.body).margin,
    scrollTop: document.scrollingElement.scrollTop,
  }
})

export default spec({ page: 'desktop', bands: ['wide', 'phone'] }, ({ test }) => {
  for (const zoom of ['0.8', '1.25', '1.5']) {
    test(`at a page zoom of ${zoom} the body is the window and the document does not scroll`, async (t) => {
      await t.prefs({ pageZoom: zoom })
      t.expectThat.equal(await t.read.attribute('body', ZOOM), zoom, `the page is drawn at ${zoom}`)
      // A box the size of the window, laid over the page the way a layer that
      // measures the window writes itself: `zoom` draws it a factor larger.
      await t.page.evaluate(() => {
        const tall = document.createElement('div')
        tall.id = 'debugWindowBox'
        tall.style.cssText = 'position: absolute; top: 0; left: 0; width: 10px; height: 100vh; background: currentColor;'
        document.body.append(tall)
      })
      const page = await read(t)
      // The window divided by the factor and multiplied back cannot always land
      // on a whole pixel, so the page's own size is right to within one.
      const near = (a, b) => Math.abs(Math.round(a) - Math.round(b)) <= 1
      t.expectThat.equal(near(page.body[0], page.inner[0]), true, 'the body is as wide as the window')
      t.expectThat.equal(near(page.body[1], page.inner[1]), true, 'the body is as tall as the window')
      t.expectThat.equal(page.scrollbar, 0, 'the document takes no scrollbar')
      // The window's own edges, less the page's one margin: a body drawn at a
      // factor past the window, or one standing an unscaled margin inside it,
      // fails here.
      t.expectThat.equal(page.bodyMargin, '0px', 'the body carries no margin of the page\'s own')
      t.expectThat.equal(near(page.bodyRight, page.inner[0]), true, 'the body ends at the window\'s right edge')
      t.expectThat.equal(page.document[0], page.room[0], 'the document is no wider than the window')
      t.expectThat.equal(near(page.document[1], page.room[1]), true, 'the document is no taller than the window')
      await t.page.mouse.wheel(0, 400)
      await t.page.waitForTimeout(300)
      t.expectThat.equal((await read(t)).scrollTop, 0, 'the wheel does not scroll the document')
    })
  }
})
