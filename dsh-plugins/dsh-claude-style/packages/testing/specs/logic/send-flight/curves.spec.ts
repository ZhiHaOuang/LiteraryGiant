/**
 * The curves the send flight is drawn from: the rise from the composer to the
 * message's row, the shape's morph, the corner and shadow it carries and the
 * stepped opacity of its text layers.
 *
 * @capability send-flight
 * @features chat-send
 * @risk A sent message visibly bounces twice, overshoots and is still off its row when the real row appears (two copies of one message), or its shell jumps where the morph ends.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import {
  CHAT_MORPH_END, CHAT_RISE_DAMPING, CHAT_RISE_OMEGA, chatSendCornerRadius, chatSendMorphProgress, chatSendRiseProgress,
  chatSendShadowSpread, chatSendSpringProgress, chatSendStepOpacity, CHAT_FLIGHT_MS, CHAT_LANDING_MS,
} from '@dsh-claude-style/client/pure'

/** The curve at `count` evenly spaced shares of the flight. */
const sampled = (curve: (u: number) => number, count = 200) => Array.from({ length: count + 1 }, (_, index) => curve(index / count))

test('a critically damped spring rises from 0 without passing 1', () => {
  const values = sampled(u => chatSendSpringProgress(u, 1, 16))
  expect(values[0]).toBe(0)
  for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
  expect(Math.max(...values)).toBeLessThanOrEqual(1)
})

test('an overdamped or critical spring never overshoots, whatever its stiffness', () => {
  fc.assert(fc.property(fc.double({ min: 1, max: 4, noNaN: true }), fc.double({ min: 2, max: 40, noNaN: true }), (damping, omega) => {
    for (const value of sampled(u => chatSendSpringProgress(u, damping, omega), 60)) expect(value).toBeLessThanOrEqual(1 + 1e-9)
  }))
})

test('the rise overshoots by the damping ratio\'s amount, and is back on the row before the fade', () => {
  const peak = Math.max(...sampled(u => chatSendSpringProgress(u, CHAT_RISE_DAMPING, CHAT_RISE_OMEGA), 2000))
  const ratio = CHAT_RISE_DAMPING / Math.sqrt(1 - CHAT_RISE_DAMPING * CHAT_RISE_DAMPING)
  expect(peak - 1).toBeCloseTo(Math.exp(-Math.PI * ratio), 3)
  // The give is the landing, so it has to be a distance a reader can see: what
  // is written here is a share of the rise, so the flight reads the same on any
  // screen and a ratio near critical fails rather than passing quietly.
  expect(peak - 1).toBeGreaterThan(0.02)
  expect(peak - 1).toBeLessThan(0.04)
  expect(chatSendRiseProgress(0)).toBe(0)
  expect(chatSendRiseProgress(1)).toBe(1)
  // One peak, on the way up: nothing the reader sees is a second bounce.
  const values = sampled(chatSendRiseProgress, 2000)
  const peakAt = values.indexOf(Math.max(...values))
  expect(peakAt).toBeGreaterThan(0)
  expect(peakAt).toBeLessThan(values.length - 1)
  for (let index = 1; index <= peakAt; index += 1) expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]!)
  for (let index = peakAt + 1; index < values.length; index += 1) expect(values[index]).toBeLessThanOrEqual(values[index - 1]!)
  // The landing fade starts one surface duration past the flight's own end, and
  // the real row waits behind half a pixel (send-flight.ts's arrived()): what is
  // left of the give there has to be under that over any rise a reader sees.
  const fadeAt = (CHAT_FLIGHT_MS + CHAT_LANDING_MS) / CHAT_FLIGHT_MS
  expect(fadeAt).toBeGreaterThan(1)
  expect(Math.abs(chatSendRiseProgress(fadeAt) - 1)).toBeLessThan(0.01)
})

test('the shape runs its whole course within its share of the flight', () => {
  expect(chatSendMorphProgress(0)).toBe(0)
  expect(chatSendMorphProgress(CHAT_MORPH_END)).toBe(1)
  expect(chatSendMorphProgress(1)).toBe(1)
  // Normalised by its end value: no jump where the window ends.
  expect(chatSendMorphProgress(CHAT_MORPH_END - 1e-9)).toBeCloseTo(1, 6)
  const values = sampled(chatSendMorphProgress)
  for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
})

test('a corner on a non-uniformly scaled shell is written per axis, never divided by zero', () => {
  expect(chatSendCornerRadius(20, 0.5, 1)).toBe('40px / 20px')
  expect(chatSendCornerRadius(20, 0, 1)).toBe('1000px / 20px')
  fc.assert(fc.property(fc.double({ min: 0, max: 2, noNaN: true }), fc.double({ min: 0, max: 2, noNaN: true }), (sx, sy) => {
    expect(chatSendCornerRadius(20, sx, sy)).toMatch(/^\d+(\.\d+)?px \/ \d+(\.\d+)?px$/)
  }))
})

test('a shadow reaches as far as its widest layer, colour functions aside', () => {
  expect(chatSendShadowSpread('none')).toBe(0)
  expect(chatSendShadowSpread('')).toBe(0)
  expect(chatSendShadowSpread('0px 4px 12px 2px rgba(0, 0, 0, 0.1), 0px 0px 0px 1px rgb(10 20 30)')).toBe(14)
  expect(chatSendShadowSpread('rgba(0, 0, 0, 0.5) 0px 8px 24px')).toBe(24)
})

test('a stepped opacity lights only inside its window', () => {
  expect(chatSendStepOpacity(0.2, 0.6)).toEqual([
    { offset: 0, opacity: '0' }, { offset: 0.2, opacity: '0' },
    { offset: 0.2, opacity: '1' }, { offset: 0.6, opacity: '1' },
    { offset: 0.6, opacity: '0' }, { offset: 1, opacity: '0' },
  ])
  expect(chatSendStepOpacity(0, 1)).toEqual([{ offset: 0, opacity: '1' }, { offset: 1, opacity: '1' }])
})

test('a stepped opacity is a valid keyframe list for any window inside the flight', () => {
  const window = fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
    .filter(([a, b]) => a < b)
  fc.assert(fc.property(window, ([from, until]) => {
    const frames = chatSendStepOpacity(from, until)
    expect(frames[0]!.offset).toBe(0)
    expect(frames.at(-1)!.offset).toBe(1)
    for (let i = 1; i < frames.length; i += 1) expect(frames[i]!.offset ?? 0).toBeGreaterThanOrEqual(frames[i - 1]!.offset ?? 0)
    // The browser accepts it as written: a list out of order or outside [0, 1] throws here.
    new KeyframeEffect(null, frames, 100)
  }))
})
