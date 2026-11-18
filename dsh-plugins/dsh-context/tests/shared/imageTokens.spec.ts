import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateImageTokens } from '../../src/shared/imageTokens'

describe('estimateImageTokens', () => {
  test('the reference calculator prices each size, including the 8:1 aspect clamp', () => {
    for (const [w, h, expected] of [
      [2048, 1365, 313],
      [800, 600, 341],
      [2048, 2048, 349],
      [512, 512, 201],
      [100, 100, 117],
      [1920, 1080, 369],
      [400, 900, 249],
      [8000, 1000, 301],
      [1000, 8000, 341],
    ] as const) {
      assert.equal(estimateImageTokens(w, h), expected, `${w}×${h}`)
    }
  })

  test('every valid size lands inside the documented cap band', () => {
    for (let w = 16; w <= 4096; w *= 2) {
      for (let h = 16; h <= 4096; h *= 2) {
        const tokens = estimateImageTokens(w, h)
        assert.ok(tokens !== null && tokens >= 113 && tokens <= 384, `${w}×${h} → ${tokens}`)
      }
    }
  })

  test('a tall strip beyond the ~190:1 grid threshold solves on the collapsed-width arm', () => {
    assert.equal(estimateImageTokens(50, 12000), 381)
  })

  test('a first-solve overflow walks the budget down until the grid fits', () => {
    assert.equal(estimateImageTokens(360, 3243), 281)
  })

  test('non-positive or non-finite dimensions return null', () => {
    assert.equal(estimateImageTokens(0, 100), null)
    assert.equal(estimateImageTokens(100, 0), null)
    assert.equal(estimateImageTokens(-5, 100), null)
    assert.equal(estimateImageTokens(100, -5), null)
    assert.equal(estimateImageTokens(NaN, 100), null)
    assert.equal(estimateImageTokens(100, Infinity), null)
  })

  test('astronomical (finite) dimensions fail to converge and return null instead of throwing', () => {
    assert.equal(estimateImageTokens(Number.MAX_VALUE, Number.MAX_VALUE), null)
  })
})
