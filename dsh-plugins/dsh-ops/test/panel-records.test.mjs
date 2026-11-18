/** Persisted JSON is untrusted: malformed field shapes must not corrupt text or totals. */
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createPanelCollector, foldRecords, parseAppendLog, projectEvent } from '../lib/panel/collect.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
const message = { record: 'event', seq: 0, time: 1, type: 'assistant/message',
  payload: { text: 'kept exactly', chars: 12, truncated: false, droppedChars: 0 },
  usageReported: true, usageBuckets: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }

await test('invalid persisted fields are counted and marked degraded without coercing text or usage', () => {
  const broken = [
    { ...message, seq: 1, payload: { text: { hidden: 'must not stringify' }, chars: 3 } },
    { ...message, seq: 2, payload: { text: 'bad count', chars: '9000' } },
    { ...message, seq: 3, usage: { inputTokens: '6000' } },
    { ...message, seq: 4, time: 9e15 },
  ]
  const parsed = parseAppendLog([...broken, message].map(value => JSON.stringify(value)).join('\n') + '\nnull\n[]\nnot json\n')
  assert.deepEqual(parsed.records, [...broken, message], 'parsing preserves object values exactly')
  assert.equal(parsed.malformed, 3)
  const document = foldRecords(parsed.records, { malformed: parsed.malformed })
  assert.equal(document.events.malformed, 7)
  assert.equal(document.metrics.malformed, 7)
  assert.equal(document.metrics.eventCount, 1)
  assert.equal(document.verify.degraded, true)
  assert.equal(document.metrics.usageReported, false, 'omitted malformed events cannot imply complete totals')
  assert.equal(document.metrics.usage.grandTotal, 5)
  assert.equal(document.metrics.textChars, 12)
  assert.deepEqual(document.conversation.map(row => row.text), ['kept exactly'])
})

await test('valid projected records retain partial usage, new event types and nullable text defaults', () => {
  const event = projectEvent({ type: 'assistant/message', seq: 0, time: 1, data: {
    message: { content: [{ type: 'text', text: 'first' }, null, { type: 'text', text: 'second' }] },
    usage: { inputTokens: 1.4, outputTokens: 2.6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 3.6 },
  } })
  assert.equal(event.payload.text, 'first\nsecond')
  const records = [{ record: 'event', ...event }, { record: 'event', seq: 1, time: 2, type: 'future/event', future: { kept: true } },
    { record: 'event', seq: 2, time: 3, type: 'user/message', payload: { text: null, chars: null } }]
  const document = foldRecords(parseAppendLog(records.map(value => JSON.stringify(value)).join('\n')).records)
  assert.equal(document.events.malformed, 0)
  assert.equal(document.verify.degraded, false)
  assert.equal(document.events.types['future/event'], 1)
  assert.equal(document.metrics.eventCount, 3)
  assert.deepEqual(document.metrics.usage, { inputTokens: 1, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4, grandTotal: 4 })
  assert.deepEqual(document.conversation.map(row => row.text), ['first\nsecond', ''])
})

await test('a malformed persisted event cannot prevent valid crash recovery or explicit sealing', async () => {
  await withTempDir('panel-typed-recovery', async cwd => {
    const dir = path.join(cwd, '.dsh-ops', 'panel'), wal = path.join(dir, 'typed.ndjson')
    fs.mkdirSync(dir, { recursive: true })
    const records = [{ record: 'open', sessionId: 'typed', cwd }, { ...message, seq: 1, time: 9e15 }, message]
    fs.writeFileSync(wal, records.map(value => JSON.stringify(value)).join('\n') + '\n')
    const collector = createPanelCollector({ env: { DSH_HOME: path.join(tmpdir(), 'panel-typed-separate-home') } })
    collector.observe({ id: 'typed', header: { cwd } }, { type: 'turn/end', seq: 2, time: 3, data: {} })
    await collector.flush()
    const document = JSON.parse(fs.readFileSync(path.join(dir, 'typed.json'), 'utf8'))
    assert.equal(document.metrics.malformed, 1)
    assert.equal(document.verify.degraded, true)
    assert.deepEqual(document.conversation.map(row => row.text), ['kept exactly'])
    assert.equal(fs.existsSync(wal), true)
    await collector.close('typed')
    assert.equal(fs.existsSync(wal), false)
    assert.equal(collector.size, 0)
    await collector.stop()
  })
})
report('panel-records')
