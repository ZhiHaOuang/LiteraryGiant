import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserve, settle, count } from './budget.mjs'
test('twenty slots survive restart and failed requests never refund a slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-request-budget-'))
  for (let i = 1; i <= 20; i++) assert.equal(reserve(dir, { test: true }), i)
  settle(dir, 1, { failure: 'interrupted' })
  assert.equal(count(dir), 20)
  assert.throws(() => reserve(dir, {}), /20/)
  assert.throws(() => reserve(dir, {}, 21), /Invalid/)
})
test('a closed ledger cannot spend its remaining slots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-closed-budget-'))
  reserve(dir, { test: true })
  writeFileSync(join(dir, 'closure.json'), '{"closed":true}')
  assert.throws(() => reserve(dir, {}), /结算关闭/)
  assert.equal(count(dir), 1)
})
