/**
 * The reasoning-effort button wears a colour that follows the rung in force: every
 * thinking level takes its own step along a ramp from the accent toward the violet
 * the card's apex wears, deepening as it climbs, and the Composer tab's
 * effort-accent row is what turns the colour on — with it off, every rung keeps
 * the resting ink.
 *
 * @capability effort-picker
 * @features effort
 * @risk The reader cannot tell the strongest rung from the ones below it without opening the card, so they work at a weaker or stronger effort than they meant.
 */
import { spec } from '../../fixtures/behaviour.mjs'

/** The colour an element paints its text in, as the pixels the reader sees: a mixed colour and a token resolve to one serialization only through the canvas. */
function painted(t, selector) {
  return t.page.evaluate((s) => {
    const element = document.querySelector(s)
    if (element === null) return null
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.fillStyle = '#000000'
    context.fillStyle = getComputedStyle(element).color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return `rgb(${r}, ${g}, ${b})`
  }, selector)
}

/** How far a painted colour sits from the page's canvas, as the contrast ratio a reader's eye would see. */
function contrastWithPage(t, colour) {
  return t.page.evaluate((css) => {
    const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = ([r, g, b]) => {
      const channel = (value) => {
        const c = value / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.fillStyle = '#000000'
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    const here = luminance(parse(css))
    const page = luminance([r, g, b])
    return Math.round(((Math.max(here, page) + 0.05) / (Math.min(here, page) + 0.05)) * 100) / 100
  }, colour)
}

/** Press the track `share` of the way along, and let the level settle. */
async function pick(t, share) {
  const track = await t.read.box(t.surface('effort.track'))
  await t.page.mouse.click(track.left + track.width * share, track.top + track.height / 2)
  await t.settle()
  return t.read.text(t.surface('effort.trigger'))
}

/** The effort page's card, open on the level the page starts on. */
async function open(t) {
  await t.page.click(t.surface('effort.trigger'))
  await t.settle()
}

/** The four stops of the stand-in's ladder, weakest first; the last press stays just inside the track's right edge. */
const STOPS = [0, 1 / 3, 2 / 3, 0.97]

export default spec({ page: 'effort' }, ({ test }) => {
  test('every rung takes a colour of its own, the strongest the heaviest', async (t) => {
    const trigger = t.surface('effort.trigger')
    await open(t)
    const colours = []
    for (const share of STOPS) {
      await pick(t, share)
      colours.push(await painted(t, trigger))
    }
    t.expectThat.equal(new Set(colours).size, colours.length, `four rungs, four colours (${colours.join(', ')})`)
    // The ladder reads as strength: the strongest rung stands furthest from the
    // canvas it is drawn on, so the eye ranks the four without reading a word.
    const weight = async (colour) => contrastWithPage(t, colour)
    const weakest = await weight(colours[0])
    const strongest = await weight(colours[colours.length - 1])
    t.expectThat.equal(strongest > weakest, true, `the strongest rung is the heaviest (${strongest} against ${weakest})`)
  })

  test('the open card level name carries the trigger colour, the caption keeps its grey, and the hue is the theme accent', async (t) => {
    await open(t)
    const labelBefore = await painted(t, t.surface('effort.label'))
    const endBefore = await painted(t, t.surface('effort.end'))
    await pick(t, 0)
    const labelLow = await painted(t, t.surface('effort.label'))
    const endLow = await painted(t, t.surface('effort.end'))
    t.expectThat.equal([labelLow, endLow].join(), [labelBefore, endBefore].join(), 'the caption and the scale ends keep their own inks across the ladder')

    await pick(t, 0.97)
    const trigger = await painted(t, t.surface('effort.trigger'))
    const value = await painted(t, t.surface('effort.value'))
    const preview = await painted(t, t.surface('effort.value-preview'))
    t.expectThat.equal([value, preview].every(colour => colour === trigger), true, `the card's level name takes the trigger's rung colour (${[trigger, value, preview].join(', ')})`)

    const channels = colour => colour.match(/[\d.]+/g).slice(0, 3).map(Number)
    const hue = (rgb) => {
      const [r, g, b] = rgb.map(value => value / 255)
      const max = Math.max(r, g, b)
      const delta = max - Math.min(r, g, b)
      if (delta === 0) return 0
      const raw = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
      return (raw * 60 + 360) % 360
    }
    await t.page.evaluate(() => document.body.style.setProperty('--dsw-alias-brand-primary', '#00ff00'))
    await pick(t, 0)
    const lowGreen = channels(await painted(t, t.surface('effort.trigger')))
    t.expectThat.equal(lowGreen[1] > lowGreen[0] + 30 && lowGreen[1] > lowGreen[2] + 30, true, `the weak rung keeps the accent's green hue (${lowGreen.join(', ')})`)
    await pick(t, 0.97)
    const highGreen = channels(await painted(t, t.surface('effort.trigger')))
    t.expectThat.equal(hue(highGreen) < hue(lowGreen) - 8 && hue(highGreen) > 45, true, `an accent below 180° leans toward 0° without losing its hue (${hue(lowGreen).toFixed(0)}° → ${hue(highGreen).toFixed(0)}°)`)

    await t.page.evaluate(() => document.body.style.setProperty('--dsw-alias-brand-primary', '#0066ff'))
    await pick(t, 0)
    const lowBlue = channels(await painted(t, t.surface('effort.trigger')))
    await pick(t, 0.97)
    const highBlue = channels(await painted(t, t.surface('effort.trigger')))
    t.expectThat.equal(hue(highBlue) > hue(lowBlue) + 8 && hue(highBlue) < 320, true, `an accent above 180° leans toward 359° without losing its hue (${hue(lowBlue).toFixed(0)}° → ${hue(highBlue).toFixed(0)}°)`)
    await t.page.evaluate(() => document.body.style.removeProperty('--dsw-alias-brand-primary'))
    await t.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  })

  test('the effort-accent row is what paints the colour, and off leaves every rung one ink', async (t) => {
    const trigger = t.surface('effort.trigger')
    await open(t)
    const topOn = await painted(t, trigger)
    const low = await pick(t, 0)
    const lowOn = await painted(t, trigger)
    t.expectThat.equal(lowOn !== topOn, true, `the weakest rung takes another colour (${low}: ${lowOn} against ${topOn})`)
    await t.prefs({ effortAccent: false })
    const lowOff = await painted(t, trigger)
    await pick(t, 1)
    const topOff = await painted(t, trigger)
    t.expectThat.equal(lowOff, topOff, 'with the row off both rungs keep the resting ink')
    t.expectThat.equal(topOff !== topOn, true, `the row is what painted the strongest rung (${topOn} on, ${topOff} off)`)
  })
})
