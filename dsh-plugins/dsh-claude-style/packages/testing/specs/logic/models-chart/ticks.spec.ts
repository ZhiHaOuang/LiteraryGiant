/**
 * The models chart's date axis: a thirty-day window at the dashboard's width
 * thins its labels until they clear one another, a week labels every day, and
 * the newest day keeps its date when the axis has room for only one label.
 *
 * @capability models-chart
 * @features home
 * @risk A crowded date axis overlaps its labels, drops the newest day's date, or lets a label run past the plot.
 */
import { expect, test } from 'vitest'
import { HOME_CHART_LABEL_GAP, homeChartTicks } from '@dsh-claude-style/client/pure'

// The dashboard's plot width and a Chinese date's width at the label's 11px.
const WIDTH = 422
const COUNT = 30
const LABEL = 42

/** Every day's label, all the same width. */
function widths(count: number, width = LABEL) {
  return Array.from({ length: count }, () => width)
}

test('a thirty-day axis keeps only labels that clear one another, and the newest day keeps its date', () => {
  const labels = widths(COUNT)
  const ticks = homeChartTicks(labels, WIDTH)
  expect(ticks.length).toBeGreaterThan(1)
  expect(ticks.length).toBeLessThan(COUNT)
  expect(ticks[ticks.length - 1]!.index).toBe(COUNT - 1)
  for (let i = 1; i < ticks.length; i += 1) {
    const before = ticks[i - 1]!
    const after = ticks[i]!
    expect(before.left + labels[before.index]! + HOME_CHART_LABEL_GAP).toBeLessThanOrEqual(after.left)
  }
  for (const tick of ticks) {
    expect(tick.left).toBeGreaterThanOrEqual(0)
    expect(tick.left + labels[tick.index]!).toBeLessThanOrEqual(WIDTH)
  }
})

test('a week at the same width keeps every day\'s label', () => {
  const ticks = homeChartTicks(widths(7), WIDTH)
  expect(ticks.map(tick => tick.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('the cadence stays even at a two-digit day, so the newest day leaves no hole before it', () => {
  const ticks = homeChartTicks(widths(COUNT, 54), WIDTH)
  const steps = ticks.slice(1).map((tick, at) => tick.index - ticks[at]!.index)
  expect(new Set(steps).size).toBe(1)
  expect(ticks[ticks.length - 1]!.index).toBe(COUNT - 1)
})

test('an axis too narrow for two labels keeps the newest day alone', () => {
  const ticks = homeChartTicks(widths(COUNT, 60), 70)
  expect(ticks.map(tick => tick.index)).toEqual([COUNT - 1])
})

test('an axis with no width draws no label', () => {
  expect(homeChartTicks(widths(COUNT), 0)).toEqual([])
})
