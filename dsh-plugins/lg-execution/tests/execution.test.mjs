import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Ledger } from '../src/ledger.js'
import { Executor } from '../src/run.js'

const config = { provider: 'test', model: 'fiction', budgetCny: 10, inputCnyPerMillion: 1.2,
  outputCnyPerMillion: 8, maxInputBytes: 16000, maxOutputTokens: 4096, timeoutMs: 3000 }
const input = { system: '只润色选区，不扩写。', input: '她回到码头。' }
function setup(t, stream, overrides = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'lg-execution-')), 'budget.sqlite3')
  const ledger = new Ledger(path), calls = []
  const llm = { async prepareCall(config, signal) {
    signal.throwIfAborted()
    return { config, stream(options) { calls.push(options); return stream(options) } }
  } }
  const executor = new Executor(llm, ledger, { ...config, ...overrides })
  t.after(async () => { await executor.dispose(); ledger.close() })
  return { executor, ledger, calls, path, llm }
}
async function* success() {
  yield { type: 'text-delta', index: 0, text: '她回到码头。' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '她回到码头。' } }
  yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 8 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
test('one bounded DSH call returns final text once and captures usage', async t => {
  const s = setup(t, success), result = await s.executor.run(randomUUID(), input)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.result.text, '她回到码头。')
  assert.deepEqual(result.result.usage, { inputTokens: 30, outputTokens: 8 })
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].maxTokens, 4096)
  assert.equal(s.calls[0].tools, undefined)
})
test('durable operation id prevents duplicate billing across executor restart', async t => {
  const s = setup(t, success), id = randomUUID(), result = await s.executor.run(id, input)
  const reopened = new Ledger(s.path), executor = new Executor(s.llm, reopened, config)
  try {
    assert.deepEqual(await executor.run(id, input), result)
    await assert.rejects(executor.run(id, { ...input, input: '更换内容' }), /不能更换/)
    assert.equal(s.calls.length, 1)
  } finally { await executor.dispose(); reopened.close() }
})
test('exhausted cumulative budget and oversized context refuse before model dispatch', async t => {
  const s = setup(t, success, { budgetCny: 0.04 })
  await s.executor.run(randomUUID(), input)
  await assert.rejects(s.executor.run(randomUUID(), input), /预算不足/)
  await assert.rejects(s.executor.run(randomUUID(), { ...input, input: '字'.repeat(10000) }), /输入超过/)
  assert.equal(s.calls.length, 1)
})
test('truncated output remains failed and is never silently retried', async t => {
  const s = setup(t, async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } })
  const id = randomUUID(), result = await s.executor.run(id, input)
  assert.equal(result.status, 'failed')
  assert.deepEqual(await s.executor.run(id, input), result)
  assert.equal(s.calls.length, 1)
  assert.ok(s.ledger.totals().reservedCny > 0)
})
test('cancellation settles without releasing unknown charged reservation; no secret errors saved', async t => {
  const s = setup(t, async function* ({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('secret header that must not be persisted')
  })
  const id = randomUUID(), pending = s.executor.run(id, input)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.executor.cancel(id), true)
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.ok(!JSON.stringify(result).includes('secret header'))
  assert.ok(result.reservedCny > 0)
})
test('concurrent duplicate cannot start a second model request and disposal cancels the first', async t => {
  const s = setup(t, async function* ({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    signal.throwIfAborted()
  })
  const id = randomUUID(), first = s.executor.run(id, input)
  assert.equal((await s.executor.run(id, input)).status, 'reserved')
  await s.executor.dispose()
  assert.equal((await first).status, 'cancelled')
  assert.equal(s.calls.length, 1)
  await assert.rejects(s.executor.run(randomUUID(), input), /已停用/)
})
test('cost estimate counts cache and reasoning conservatively when adapter counters are separate', async t => {
  const s = setup(t, async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '正文' } }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const result = await s.executor.run(randomUUID(), input)
  assert.equal(result.result.estimatedCny, (150 * 1.2 + 25 * 8) / 1e6)
})
