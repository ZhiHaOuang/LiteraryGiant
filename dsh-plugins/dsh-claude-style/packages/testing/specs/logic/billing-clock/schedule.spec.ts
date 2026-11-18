/**
 * The billing clock's judgement: whether a provider bills at its peak rate,
 * off-peak or under a promotion at an instant, and how long until that changes.
 * Every case names its instant in UTC, so the schedule's own zone is the only
 * thing that moves the answer.
 *
 * @capability billing-clock
 * @features peakrate
 * @risk The model picker tells the reader a model is off-peak while they are billed at the peak rate, or counts down to a switch that never comes.
 */
import { beforeEach, expect, test } from 'vitest'
import fc from 'fast-check'
import { currentRate, forgetRates, formatCountdown } from '@dsh-claude-style/client/pure'
import type { RateProfile, RateSchedule } from '@dsh-claude-style/contracts/peakrate'

beforeEach(() => {
  forgetRates()
})

function profile(schedule: RateSchedule, id = 'fixture'): RateProfile {
  return { id, provider: 'DeepSeek', model: 'Fixture', schedule, peakBadge: '2×', offPeakBadge: '1×' }
}

/** Weekdays 01:00–04:00 UTC, one window — the shape the official service publishes. */
const WEEKDAY_WINDOW: RateSchedule = { timeZone: 'UTC', peakDays: [1, 2, 3, 4, 5], peakWindows: [{ start: '01:00', end: '04:00' }] }

/** A window crossing midnight, the shape the promotional profiles use. */
const NIGHT_WINDOW: RateSchedule = { timeZone: 'UTC', peakDays: [1, 2, 3, 4, 5], peakWindows: [{ start: '23:00', end: '09:00' }] }

test('a weekday inside its window bills peak, and the countdown names the window end', () => {
  // 2026-10-07 is a Wednesday.
  const state = currentRate(profile(WEEKDAY_WINDOW), new Date('2026-10-07T02:00:00Z'))
  expect(state).toMatchObject({ period: 'peak', badge: '2×', minutesUntilSwitch: 120, nextPeriod: 'offPeak', nextBadge: '1×' })
})

test('between two windows the state is off-peak, and the next window is tomorrow', () => {
  const state = currentRate(profile(WEEKDAY_WINDOW), new Date('2026-10-07T05:00:00Z'))
  expect(state).toMatchObject({ period: 'offPeak', nextPeriod: 'peak', minutesUntilSwitch: 20 * 60 })
})

test('a weekend day is off-peak from midnight to midnight', () => {
  // 2026-10-10 is a Saturday, 2026-10-11 a Sunday; Monday 01:00 is 47 hours after Saturday 02:00.
  expect(currentRate(profile(WEEKDAY_WINDOW, 'saturday'), new Date('2026-10-10T02:00:00Z'))).toMatchObject({ period: 'offPeak', minutesUntilSwitch: 47 * 60 })
  expect(currentRate(profile(WEEKDAY_WINDOW, 'sunday'), new Date('2026-10-11T02:00:00Z'))).toMatchObject({ period: 'offPeak', minutesUntilSwitch: 23 * 60 })
})

test('a window crossing midnight belongs to the day it starts', () => {
  expect(currentRate(profile(NIGHT_WINDOW, 'evening'), new Date('2026-10-07T23:30:00Z')).period).toBe('peak')
  expect(currentRate(profile(NIGHT_WINDOW, 'spill'), new Date('2026-10-08T02:00:00Z'))).toMatchObject({ period: 'peak', minutesUntilSwitch: 7 * 60 })
  // Saturday 02:00 is still Friday's window: the start day is the one judged.
  expect(currentRate(profile(NIGHT_WINDOW, 'fridayLeg'), new Date('2026-10-10T02:00:00Z')).period).toBe('peak')
  // Sunday 02:00 has no window behind it — Saturday is no peak day.
  expect(currentRate(profile(NIGHT_WINDOW, 'sundayLeg'), new Date('2026-10-11T02:00:00Z')).period).toBe('offPeak')
})

test('the same instant is judged in each schedule\'s own zone', () => {
  const instant = new Date('2026-10-07T17:30:00Z')
  // 01:30 on Thursday in Shanghai: inside the window. 17:30 Wednesday in UTC: not.
  expect(currentRate(profile({ ...WEEKDAY_WINDOW, timeZone: 'Asia/Shanghai' }, 'shanghai'), instant).period).toBe('peak')
  expect(currentRate(profile(WEEKDAY_WINDOW, 'utc'), instant).period).toBe('offPeak')
})

test('a public holiday is off-peak in full, and suppresses the evening before it', () => {
  const inside = currentRate(profile({ ...WEEKDAY_WINDOW, publicHolidayDates: ['2026-10-07'] }, 'holiday'), new Date('2026-10-07T02:00:00Z'))
  expect(inside).toMatchObject({ period: 'offPeak', nextPeriod: 'peak' })
  // A window that started on the holiday evening does not make the working day after it peak.
  const spill = currentRate(profile({ ...NIGHT_WINDOW, publicHolidayDates: ['2026-10-07'] }, 'nightHoliday'), new Date('2026-10-08T02:00:00Z'))
  expect(spill.period).toBe('offPeak')
})

test('a dated promotion outranks the regular cycle and carries its own badge', () => {
  const promoted: RateSchedule = {
    ...WEEKDAY_WINDOW,
    overrides: [{ period: 'campaign', periodName: 'promotion', badge: '0.5×', name: 'All-day off-peak', startDate: '2026-10-01', endDate: '2026-10-07', days: [], windows: [{ start: '00:00', end: '00:00' }] }],
  }
  expect(currentRate(profile(promoted, 'promoted'), new Date('2026-10-07T02:00:00Z'))).toMatchObject({ period: 'campaign', badge: '0.5×', overrideName: 'All-day off-peak' })
  // The day after the window closes the regular cycle is back at the rate the source prints.
  expect(currentRate(profile(promoted, 'promotedAfter'), new Date('2026-10-08T02:00:00Z'))).toMatchObject({ period: 'peak', badge: '2×' })
})

test('a promotion inside one part of the day switches back to the regular cycle', () => {
  const campaign: RateSchedule = {
    ...WEEKDAY_WINDOW,
    overrides: [{ period: 'campaign', periodName: 'campaign', badge: 'Campaign', startDate: '2026-09-03', endDate: '2026-10-07', days: [], windows: [{ start: '23:00', end: '09:00' }] }],
  }
  expect(currentRate(profile(campaign, 'campaign'), new Date('2026-10-07T02:00:00Z'))).toMatchObject({ period: 'campaign', minutesUntilSwitch: 7 * 60, nextPeriod: 'offPeak' })
  expect(currentRate(profile(campaign, 'campaignAfter'), new Date('2026-10-07T10:00:00Z')).period).toBe('offPeak')
})

test('a window edge that changes no state is not a switch', () => {
  const twoWindows: RateSchedule = { timeZone: 'UTC', peakDays: [1, 2, 3, 4, 5], peakWindows: [{ start: '01:00', end: '04:00' }, { start: '04:00', end: '06:00' }] }
  expect(currentRate(profile(twoWindows), new Date('2026-10-07T03:00:00Z'))).toMatchObject({ period: 'peak', minutesUntilSwitch: 3 * 60 })
})

test('a whole-day window bills the same state around the clock', () => {
  const allDay: RateSchedule = { timeZone: 'Asia/Shanghai', peakDays: [0, 1, 2, 3, 4, 5, 6], peakWindows: [{ start: '00:00', end: '00:00' }] }
  expect(currentRate(profile(allDay), new Date('2026-10-07T02:00:00Z'))).toMatchObject({ period: 'peak', badge: '2×', minutesUntilSwitch: Number.POSITIVE_INFINITY })
})

test('a campaign bounded by instants applies inside them and not outside', () => {
  const campaign: RateSchedule = {
    ...WEEKDAY_WINDOW,
    overrides: [{ period: 'campaign', periodName: 'campaign', badge: '0.9× base', startAt: '2026-08-13T09:00:00-07:00', endAt: '2026-08-20T09:00:00-07:00', days: [], windows: [{ start: '00:00', end: '00:00' }] }],
  }
  // 2026-08-13T09:00:00-07:00 is 16:00Z; 15:00Z is past that day's window.
  expect(currentRate(profile(campaign, 'beforeInstant'), new Date('2026-08-13T15:00:00Z'))).toMatchObject({ period: 'offPeak', nextPeriod: 'campaign', minutesUntilSwitch: 60 })
  expect(currentRate(profile(campaign, 'insideInstant'), new Date('2026-08-14T02:00:00Z'))).toMatchObject({ period: 'campaign', badge: '0.9× base', minutesUntilSwitch: 6 * 24 * 60 + 14 * 60 })
  // An expired campaign never applies again, even though its window covers every day.
  expect(currentRate(profile(campaign, 'afterInstant'), new Date('2026-10-07T02:00:00Z'))).toMatchObject({ period: 'peak', badge: '2×' })
})

test('a window edge inside a skipped hour switches at the transition', () => {
  // 2026-03-08 in New York jumps from 02:00 to 03:00; a window ending at 02:30 ends when the clock crosses 02:00.
  const schedule: RateSchedule = { timeZone: 'America/New_York', peakDays: [0, 1, 2, 3, 4, 5, 6], peakWindows: [{ start: '01:00', end: '02:30' }] }
  expect(currentRate(profile(schedule), new Date('2026-03-08T06:30:00Z'))).toMatchObject({ period: 'peak', minutesUntilSwitch: 30, nextPeriod: 'offPeak' })
})

test('the countdown reads in whole minutes, hours and days', () => {
  expect(formatCountdown(0)).toBe('<1m')
  expect(formatCountdown(0.4)).toBe('<1m')
  expect(formatCountdown(45)).toBe('45m')
  expect(formatCountdown(60)).toBe('1h')
  expect(formatCountdown(80)).toBe('1h 20m')
  expect(formatCountdown(1440)).toBe('1d')
  expect(formatCountdown(1500)).toBe('1d 1h')
  expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('')
})

const MINUTE = 60_000
/** Any instant across a year, on a whole minute. */
const instant = fc.integer({ min: Date.UTC(2026, 0, 1) / MINUTE, max: Date.UTC(2027, 0, 1) / MINUTE }).map((minute) => new Date(minute * MINUTE))
const zone = fc.constantFrom('UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/Berlin')

test('the state named next is the state the clock shows once the countdown runs out', () => {
  fc.assert(fc.property(instant, zone, (now, timeZone) => {
    const schedule = { ...NIGHT_WINDOW, timeZone }
    const state = currentRate(profile(schedule, `now-${now.getTime()}`), now)
    if (!Number.isFinite(state.minutesUntilSwitch)) return
    expect(state.minutesUntilSwitch).toBeGreaterThan(0)
    const before = currentRate(profile(schedule, `before-${now.getTime()}`), new Date(now.getTime() + (state.minutesUntilSwitch - 1) * MINUTE))
    const after = currentRate(profile(schedule, `after-${now.getTime()}`), new Date(now.getTime() + state.minutesUntilSwitch * MINUTE))
    expect(before.period).toBe(state.period)
    expect(after.period).toBe(state.nextPeriod)
  }), { numRuns: 200 })
})
