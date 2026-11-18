import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { cacheHitPercent, fmt, fmtBytes, fmtDateTime, fmtDuration, fmtShare, fmtTime } from '../../src/client/format'

describe('fmt', () => {
  test('missing/NaN input shows the dash', () => {
    assert.equal(fmt(undefined), '—')
    assert.equal(fmt(null), '—')
    assert.equal(fmt(NaN), '—')
  })

  test('small numbers round to integers; thousands, millions, and billions take suffixes with one decimal', () => {
    assert.equal(fmt(0), '0')
    assert.equal(fmt(999.4), '999')
    assert.equal(fmt(1000), '1.0k')
    assert.equal(fmt(1534), '1.5k')
    assert.equal(fmt(1_000_000), '1.0M')
    assert.equal(fmt(128_000), '128.0k')
    assert.equal(fmt(1_000_000_000), '1.0B')
    assert.equal(fmt(1_055_900_000), '1.1B')
  })

  test('negatives keep their sign', () => {
    assert.equal(fmt(-1500), '-1.5k')
    assert.equal(fmt(-12), '-12')
    assert.equal(fmt(-2_000_000_000), '-2.0B')
  })
})

describe('fmtBytes', () => {
  test('missing/NaN/negative input shows the dash; B/kB/MB split at decimal thresholds', () => {
    assert.equal(fmtBytes(undefined), '—')
    assert.equal(fmtBytes(null), '—')
    assert.equal(fmtBytes(NaN), '—')
    assert.equal(fmtBytes(-1), '—')
    assert.equal(fmtBytes(512), '512 B')
    assert.equal(fmtBytes(2048), '2.0 kB')
    assert.equal(fmtBytes(3_500_000), '3.5 MB')
  })
})

describe('cacheHitPercent', () => {
  test('null when nothing was billed; otherwise two decimals, cut not rounded', () => {
    assert.equal(cacheHitPercent(5, 0), null)
    assert.equal(cacheHitPercent(0, -1), null)
    assert.equal(cacheHitPercent(1, 3), '33.33')
    assert.equal(cacheHitPercent(82499, 83000), '99.39')
    assert.equal(cacheHitPercent(83000, 83000), '100.00')
  })
})

describe('fmtTime / fmtDateTime', () => {
  test('invalid dates show the dash while valid instants carry the full reading', () => {
    assert.equal(fmtTime(NaN), '—')
    assert.match(fmtTime(1000), /^\d{2}:\d{2}:\d{2}$/)
    assert.equal(fmtDateTime(NaN), '—')
    assert.match(fmtDateTime(1000), /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/)
  })
})

describe('fmtShare', () => {
  test('nothing to total shows the dash; empty slices and crumbs never round up', () => {
    assert.equal(fmtShare(0, 0), '—')
    assert.equal(fmtShare(5, 0), '—')
    assert.equal(fmtShare(NaN, 100), '—')
    assert.equal(fmtShare(5, Infinity), '—')
    assert.equal(fmtShare(0, 100), '0.0%')
    assert.equal(fmtShare(-1, 100), '0.0%')
    assert.equal(fmtShare(1, 2000), '<0.1%')
    assert.equal(fmtShare(1, 1000), '0.1%')
    assert.equal(fmtShare(0.5, 100), '0.5%')
    assert.equal(fmtShare(1, 300), '0.3%')
  })

  test('shares carry one decimal and cap at 100', () => {
    assert.equal(fmtShare(844, 1000), '84.4%')
    assert.equal(fmtShare(738.4, 1000), '73.8%')
    assert.equal(fmtShare(996, 1000), '99.6%')
    assert.equal(fmtShare(3000, 1000), '100.0%')
    assert.equal(fmtShare(1, 3), '33.3%')
  })
})

describe('fmtDuration', () => {
  test('non-finite and non-positive input shows the dash', () => {
    assert.equal(fmtDuration(0), '—')
    assert.equal(fmtDuration(-5), '—')
    assert.equal(fmtDuration(NaN), '—')
    assert.equal(fmtDuration(Infinity), '—')
  })

  test('duration steps through raw ms, seconds, minutes, and hours', () => {
    assert.equal(fmtDuration(740), '740ms')
    assert.equal(fmtDuration(999.6), '1000ms')
    assert.equal(fmtDuration(12_300), '12.3s')
    assert.equal(fmtDuration(205_000), '3m25s')
    assert.equal(fmtDuration(600_000), '10m0s')
    assert.equal(fmtDuration(4_440_000), '1h14m')
    assert.equal(fmtDuration(7_320_000), '2h2m')
  })
})
