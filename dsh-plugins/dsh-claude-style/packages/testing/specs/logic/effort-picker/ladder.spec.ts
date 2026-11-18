/**
 * The order the effort slider reads its steps in: the host records a model's
 * reasoning efforts as a strength scale, and the control builds its ladder
 * weakest first, leaving levels the table cannot rank where the adapter put them.
 * The trigger's colour is read off the same ladder: the switch-off level and the
 * model's own default level rest, and every thinking rung takes its place on a
 * ramp whose far end is the violet the card's apex matrix marks.
 *
 * @capability effort-picker
 * @features effort
 * @risk The effort slider puts "high" below "low", or moves a model's own unranked level away from where its provider listed it, so the reader picks a weaker effort than they meant; or the trigger colours a rung the card does not mark as the strongest, so the two surfaces name different levels.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { effortSteps, effortTint, isRankedEffort, orderEffortIds } from '@dsh-claude-style/client/pure'
import type { EffortLadder } from '@dsh-claude-style/client/pure'

const RANKED = ['none', 'off', 'low', 'medium', 'high', 'on', 'xhigh', 'max', 'ultra']

/** One catalog descriptor: the declared levels, the model's own default, and the level in force. */
function ladder(levels: readonly (readonly [string, string])[], effective: string | undefined, defaultEffort?: string): EffortLadder {
  return {
    reasoning: { defaultEffort, efforts: levels.map(([id, name]) => ({ id, name })) },
    effective,
  }
}

test('an unordered ladder comes back weakest first', () => {
  expect(orderEffortIds(['high', 'none'])).toEqual(['none', 'high'])
  expect(orderEffortIds(['xhigh', 'low', 'medium', 'none'])).toEqual(['none', 'low', 'medium', 'xhigh'])
  expect(orderEffortIds(['xhigh', 'high', 'low', 'max', 'medium'])).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(orderEffortIds(['high', 'low', 'max'])).toEqual(['low', 'high', 'max'])
})

test('an already ordered ladder is unchanged', () => {
  expect(orderEffortIds(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  expect(orderEffortIds(['low', 'high', 'max'])).toEqual(['low', 'high', 'max'])
})

test('a single level is unchanged', () => {
  expect(orderEffortIds(['high'])).toEqual(['high'])
  expect(orderEffortIds(['none'])).toEqual(['none'])
})

test('the model\'s own default level leads, ranked levels follow', () => {
  expect(orderEffortIds([undefined, 'high', 'none'])).toEqual([undefined, 'none', 'high'])
})

test('a level the table cannot rank keeps the place the adapter gave it', () => {
  expect(orderEffortIds(['banana', 'high', 'none'])).toEqual(['banana', 'none', 'high'])
  expect(orderEffortIds(['xhigh', 'banana', 'none'])).toEqual(['none', 'banana', 'xhigh'])
  expect(orderEffortIds(['first', 'second', 'low'])).toEqual(['first', 'second', 'low'])
})

test('the switch-off level ranks weakest and thinking-on ranks with high', () => {
  expect(isRankedEffort('none')).toBe(true)
  expect(isRankedEffort('off')).toBe(true)
  expect(orderEffortIds(['high', 'off'])).toEqual(['off', 'high'])
  expect(orderEffortIds(['on', 'none'])).toEqual(['none', 'on'])
  expect(isRankedEffort('banana')).toBe(false)
})

test('any ladder comes back as the same levels, unranked ones in place, ranked ones weakest first', () => {
  const level = fc.oneof(fc.constantFrom(...RANKED), fc.constantFrom('banana', 'first', 'second'))
  fc.assert(fc.property(fc.uniqueArray(level, { maxLength: 8 }), (ids) => {
    const ordered = orderEffortIds(ids)
    expect([...ordered].sort()).toEqual([...ids].sort())
    ids.forEach((id, at) => {
      if (!isRankedEffort(id)) expect(ordered[at]).toBe(id)
    })
    const ranked = ordered.filter((id): id is string => id !== undefined && isRankedEffort(id))
    expect(orderEffortIds(ranked)).toEqual(ranked)
    expect(orderEffortIds(ordered)).toEqual(ordered)
  }))
})

test('the ladder carries every level in strength order and the rung in force', () => {
  const { steps, index } = effortSteps(ladder([['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], 'high', 'medium'), 'Default')
  expect(steps).toEqual([
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ])
  expect(index).toBe(2)
})

test('a model whose catalog names no default leads with the default step', () => {
  const { steps, index } = effortSteps(ladder([['high', 'High'], ['none', 'Off']], undefined), 'Default')
  expect(steps).toEqual([
    { id: undefined, name: 'Default' },
    { id: 'none', name: 'Off' },
    { id: 'high', name: 'High' },
  ])
  expect(index).toBe(0)
})

test('a level the ladder does not hold reads as its first rung', () => {
  expect(effortSteps(ladder([['low', 'Low'], ['high', 'High']], 'banana'), 'Default').index).toBe(0)
})

test('the tint places every thinking rung on the ramp, the top rung at its end', () => {
  const { steps } = effortSteps(ladder([['none', 'Off'], ['low', 'Low'], ['high', 'High'], ['max', 'Max']], 'high', 'high'), 'Default')
  expect(steps.map((step) => step.id)).toEqual(['none', 'low', 'high', 'max'])
  expect([0, 1, 2, 3].map((at) => effortTint(steps, at))).toEqual([null, 1 / 3, 2 / 3, 1])
})

test('a two-rung ladder puts its only thinking level at the ramp\'s end', () => {
  const { steps } = effortSteps(ladder([['none', 'Off'], ['high', 'High']], 'high', 'none'), 'Default')
  expect([0, 1].map((at) => effortTint(steps, at))).toEqual([null, 1])
})

test('the default rung rests, and a lone thinking rung takes the ramp\'s end', () => {
  const { steps } = effortSteps(ladder([['high', 'High']], undefined), 'Default')
  expect(effortTint(steps, 0)).toBe(null)
  expect(effortTint(steps, 1)).toBe(1)
  const lone = effortSteps(ladder([['high', 'High']], 'high', 'high'), 'Default')
  expect(lone.steps).toEqual([{ id: 'high', name: 'High' }])
  expect(effortTint(lone.steps, 0)).toBe(1)
  expect(effortTint([], 0)).toBe(null)
  expect(effortTint(steps, -1)).toBe(null)
})
