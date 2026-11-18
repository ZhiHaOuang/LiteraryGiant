/**
 * The hover intent every hover-opened card shares: a pointer must dwell on a
 * trigger before its card opens, leaving gives a grace before it closes, and
 * coming back or entering the card cancels the pending close.
 *
 * @capability popover
 * @features shared
 * @risk A pointer crossing the sidebar flashes cards open, a card closes while the reader moves into it, or a timer keeps running after the card has gone.
 */
import { expect, test, vi } from 'vitest'
import fc from 'fast-check'
import { createHoverIntent } from '@dsh-claude-style/client/pure'

/** Run `body` on a fake clock with a fresh intent of these delays, and give the clock back. */
function withIntent(body: (intent: ReturnType<typeof createHoverIntent>, calls: string[]) => void, openDelay = 100, closeDelay = 100) {
  vi.useFakeTimers()
  const calls: string[] = []
  const intent = createHoverIntent(() => calls.push('open'), () => calls.push('close'), openDelay, closeDelay)
  try {
    body(intent, calls)
  } finally {
    intent.cancel()
    vi.useRealTimers()
  }
}

test('returning to a trigger cancels the pending close', () => {
  withIntent((intent, calls) => {
    intent.scheduleOpen()
    vi.advanceTimersByTime(100)
    intent.scheduleClose()
    vi.advanceTimersByTime(50)
    intent.scheduleOpen()
    vi.advanceTimersByTime(100)
    expect(calls).toEqual(['open', 'open'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

test('leaving a trigger cancels its pending open and closes after the grace', () => {
  withIntent((intent, calls) => {
    intent.scheduleOpen()
    vi.advanceTimersByTime(50)
    intent.scheduleClose()
    vi.advanceTimersByTime(99)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['close'])
  })
})

test('entering the panel cancels pending hover work', () => {
  withIntent((intent, calls) => {
    intent.scheduleClose()
    intent.cancel()
    vi.advanceTimersByTime(100)
    expect(calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

test('whatever the pointer does, nothing opens before a full dwell and at most one timer is pending', () => {
  const move = fc.tuple(fc.constantFrom('enter', 'leave', 'card'), fc.integer({ min: 0, max: 250 }))
  fc.assert(fc.property(fc.array(move, { maxLength: 20 }), (moves) => {
    withIntent((intent, calls) => {
      let enteredAt: number | null = null
      let now = 0
      for (const [kind, gap] of moves) {
        if (kind === 'enter') { intent.scheduleOpen(); enteredAt = now }
        else if (kind === 'leave') { intent.scheduleClose(); enteredAt = null }
        else { intent.cancel(); enteredAt = null }
        expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
        const before = calls.length
        vi.advanceTimersByTime(gap)
        now += gap
        // An open only ever lands a whole dwell after the pointer came in.
        if (calls.slice(before).includes('open')) expect(enteredAt !== null && now - enteredAt >= 100).toBe(true)
      }
    })
  }))
})
