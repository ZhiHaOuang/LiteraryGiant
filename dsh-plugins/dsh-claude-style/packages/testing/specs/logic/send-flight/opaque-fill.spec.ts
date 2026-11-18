/**
 * The plate a flying message is painted on: a translucent bubble fill is
 * written as the colour the screen actually shows over its backdrop, so the
 * stand-in and the row it lands on are one colour.
 *
 * @capability send-flight
 * @features chat-send
 * @risk A sent message flies on a plate of a different shade from the row it lands on, and the landing reads as a flash.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { chatSendOpaque } from '@dsh-claude-style/client/pure'

test('a translucent fill is written as the colour the screen paints', () => {
  // The host's own light user bubble over its canvas.
  expect(chatSendOpaque('rgba(0, 0, 0, 0.08)', 'rgb(252, 252, 251)')).toBe('rgb(232, 232, 231)')
  // An opaque fill is already the screen's colour and is left byte for byte.
  expect(chatSendOpaque('rgb(234, 240, 254)', 'rgb(251, 252, 255)')).toBe('rgb(234, 240, 254)')
  expect(chatSendOpaque('rgba(234, 240, 254, 1)', 'rgb(251, 252, 255)')).toBe('rgba(234, 240, 254, 1)')
})

test('a colour the browser can paint is read in whatever form the page states it', () => {
  // A mix the page hands over resolved: the canvas's own paint is the reading.
  expect(chatSendOpaque('color-mix(in srgb, black 8%, transparent)', 'rgb(252, 252, 251)')).toBe('rgb(232, 232, 231)')
})

test('an unreadable colour or backdrop leaves the fill alone', () => {
  // A fill nobody can read is better left as the page wrote it than guessed at.
  expect(chatSendOpaque('#fffff', 'rgb(252, 252, 251)')).toBe('#fffff')
  expect(chatSendOpaque('rgba(0, 0, 0, 0.08)', '#fffff')).toBe('rgba(0, 0, 0, 0.08)')
  expect(chatSendOpaque('rgba(0, 0, 0, 0.08)', 'rgba(0, 0, 0, 0)')).toBe('rgba(0, 0, 0, 0.08)')
})

/** The pixel the browser itself paints for a fill over an opaque backdrop. */
function painted(fill: string, behind: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')!
  context.fillStyle = behind
  context.fillRect(0, 0, 1, 1)
  context.fillStyle = fill
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

/**
 * How far one channel of the painted pixel may stand from the written colour.
 * The browser keeps a fill's alpha in eight bits and blends in whole channel
 * steps, rounding the premultiplied fill and the result: up to half a step from
 * the alpha, and half a step from each rounding, against the exact mix written.
 */
const PAINT_STEPS = 2

test('the colour written is the one the browser paints, to the steps its eight-bit blending rounds by', () => {
  const channel = fc.integer({ min: 0, max: 255 })
  fc.assert(fc.property(channel, channel, channel, fc.double({ min: 0.02, max: 0.98, noNaN: true }), channel, channel, channel, (r, g, b, alpha, br, bg, bb) => {
    const fill = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`
    const behind = `rgb(${br}, ${bg}, ${bb})`
    const written = chatSendOpaque(fill, behind).match(/^rgb\((\d+), (\d+), (\d+)\)$/)
    expect(written).not.toBeNull()
    const screen = painted(fill, behind)
    written!.slice(1).map(Number).forEach((value, at) => expect(Math.abs(value - screen[at]!)).toBeLessThanOrEqual(PAINT_STEPS))
  }))
})
