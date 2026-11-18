/**
 * The reader's own price rows: the text a row keeps, the model it answers to,
 * and how a row lays over the price tables — a filled bucket wins, a blank one
 * leaves the table's rate, and a model no table prices answers from the row
 * alone.
 *
 * @capability session-cost
 * @features context-stats
 * @risk A reader's own price is ignored, or applied to the wrong model, so the cost beside the tokens keeps the old figure or charges the wrong route.
 */
import { expect, test } from 'vitest'
import { billingRowEntry, billingRowFor, overlayBilling, parseBillingRow, parseBillingTable } from '@dsh-claude-style/contracts/billing-table'

const stored = ['kmodel|2|0.2|8', 'Kimi-K3-Custom|0|1.3|', '|9|9|9']

test('a stored row keeps the four fields it was written with, and a row with no model is no row', () => {
  expect(parseBillingRow('kmodel|2|0.2|8')).toEqual({ model: 'kmodel', cacheMiss: 2, cacheHit: 0.2, output: 8 })
  expect(parseBillingRow('|9|9|9')).toBeNull()
  expect(parseBillingTable(stored)).toHaveLength(2)
  expect(billingRowEntry(' kmodel ', ' 2 ', '0.2', '8')).toBe('kmodel|2|0.2|8')
})

test('a model id answers as the price tables match it: case and a provider prefix do not matter', () => {
  const rows = parseBillingTable(stored)
  expect(billingRowFor(rows, 'DeepSeek/KMODEL')?.model).toBe('kmodel')
  expect(billingRowFor(rows, 'kimi-k3-custom')?.model).toBe('Kimi-K3-Custom')
  expect(billingRowFor(rows, 'kimi-k3')).toBeNull()
})

test('a row lays over the table: the buckets it fills win, the blank ones keep the table\'s rate', () => {
  const rows = parseBillingTable(stored)
  const table = { cacheHit: 0.02, cacheMiss: 1, output: 4 }
  // A row with every bucket filled replaces all three.
  expect(overlayBilling(rows, 'kmodel', undefined)).toEqual({ cacheHit: 0.2, cacheMiss: 2, output: 8 })
  // A row that fills input and cache read keeps the table's output rate.
  expect(overlayBilling(rows, 'kimi-k3-custom', table)).toEqual({ cacheHit: 1.3, cacheMiss: 0, output: 4 })
  // A row with nothing filled changes nothing.
  expect(overlayBilling(parseBillingTable(['kmodel|||']), 'kmodel', table)).toEqual(table)
  // A model neither answers: the settlement stays unpriced.
  expect(overlayBilling(rows, 'unknown', undefined)).toBeUndefined()
  // A model the table prices is priced as the table says when no row names it.
  expect(overlayBilling(rows, 'deepseek-flash', table)).toEqual(table)
})
