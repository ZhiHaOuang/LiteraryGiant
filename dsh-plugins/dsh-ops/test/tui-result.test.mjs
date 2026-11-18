import { createActivityStore } from '../lib/tui/activity.js'
import { resultDetails } from '../lib/tui/result.js'
import { activityLines } from '../lib/tui/panel.js'
import { call, result, dispatch } from './lib/activity-events.mjs'
import { definition } from '../lib/file/contract.js'
import { resultDefinition } from '../lib/file/result.js'
import { assert, report, test } from './lib/harness.mjs'
const inspect = value => resultDetails('ops_grep', result(2, 'a', value).data, false)

await test('normal transport returns distinguish native success, refusal and operation failure', () => {
  assert.equal(inspect({ status: 'completed' }).outcome, 'completed')
  assert.equal(inspect({ status: 'rejected', error: { code: 'POLICY_DENIED' } }).outcome, 'rejected')
  assert.equal(inspect({ status: 'error' }).outcome, 'error')
  const blocked = result(2, 'a', { status: 'completed' }).data
  blocked.message.isError = true
  assert.equal(resultDetails('ops_grep', blocked, false).outcome, 'unconfirmed')
  const store = createActivityStore()
  store.observe('one', call(1)); store.observe('one', result(2, 'a', { status: 'rejected' }))
  assert.equal(store.snapshot('one').returned, 1)
  assert.equal(store.snapshot('one').errors, 0)
  assert.equal(store.snapshot('one').business.rejected, 1)
})
await test('Native results classify from their presentation metadata, never from model text', () => {
  const replace = definition('replace', async () => ({})).output
  const native = (seq, id, value, output = replace) => ({ type: 'tool/result', seq, time: seq * 10,
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, isError: false,
      content: output.render({}, value) }, meta: output.presentationMeta({}, value) } })
  for (const [value, outcome] of [[{ status: 'completed', changed: 1 }, 'completed'], [{ status: 'completed', dryRun: true }, 'planned'],
    [{ status: 'rejected', error: { code: 'POLICY_DENIED', effectState: 'none', message: 'read-only' } }, 'rejected'],
    [{ status: 'error', error: { code: 'NOT_FOUND', effectState: 'none', message: 'missing' } }, 'error'],
    [{ status: 'error', error: { code: 'RESULT_UNKNOWN', effectState: 'unknown', message: 'interrupted' } }, 'unknown']]) {
    const { data } = native(2, 'a', value)
    assert.equal(data.message.content[0].text.startsWith('{'), false, 'Native model text is not a JSON envelope')
    assert.equal(resultDetails('ops_replace', data, false).outcome, outcome, JSON.stringify(value))
    // The same Native text without metadata stays unconfirmed: prose is never parsed into an outcome.
    assert.equal(resultDetails('ops_replace', { ...data, meta: undefined }, false).outcome, 'unconfirmed')
  }
  const page = resultDefinition(async () => ({})).output
  assert.equal(resultDetails('ops_result', native(2, 'a', { status: 'completed', complete: false, nextOffset: 4 }, page).data, false).complete, false)
  const store = createActivityStore()
  store.observe('one', call(1, 'a', 'ops_replace'))
  store.observe('one', native(2, 'a', { status: 'rejected', error: { code: 'POLICY_DENIED', effectState: 'none', message: 'read-only' } }))
  assert.equal(store.snapshot('one').business.rejected, 1); assert.equal(store.snapshot('one').recent[0].errorCode, 'POLICY_DENIED')
  const failed = native(2, 'a', { status: 'completed' }); failed.data.message.isError = true
  assert.equal(resultDetails('ops_replace', failed.data, false).outcome, 'unconfirmed')
  const nested = { content: [{ type: 'text', text: 'not json' }], meta: { opsOutcome: { status: 'completed' } } }
  assert.equal(resultDetails('ops_glob', nested, true).outcome, 'unconfirmed', 'PTC children carry JSON, not metadata')
})
await test('presentation metadata keeps only bounded status, error code/effect and counters', () => {
  const meta = definition('grep', async () => ({})).output.presentationMeta({}, { status: 'partial', done: 2, total: 3, failed: 1,
    omitted: -1, complete: false, dryRun: 'yes', path: '/private/x', items: [{ path: '/private/x', text: 'PRIVATE' }],
    error: { code: 'NOT_FOUND', effectState: 'none', message: '/private/x', nextAction: 'retry' } })
  assert.deepEqual(meta, { opsOutcome: { status: 'partial', done: 2, total: 3, failed: 1, complete: false, error: { code: 'NOT_FOUND', effectState: 'none' } } })
  assert.deepEqual(definition('grep', async () => ({})).output.presentationMeta({}, { status: 'Bad Status', error: { code: 'lower', effectState: 'maybe' } }),
    { opsOutcome: { error: {} } })
})
await test('unknown effects outrank other outcomes and never imply safe automatic retry', () => {
  assert.equal(inspect({ status: 'completed', unknown: 1 }).outcome, 'unknown')
  assert.equal(inspect({ status: 'error', error: { effectState: 'unknown' } }).outcome, 'unknown')
  const store = createActivityStore()
  store.observe('one', dispatch(1, 'batch', 'ops_batch'))
  store.observe('one', dispatch(2, 'batch', 'ops_batch', { status: 'partial', done: 2, total: 3, unknown: 1 }))
  const lines = activityLines(store.snapshot('one'), 'zh', 30).join('\n')
  assert.match(lines, /副作用未知 1/); assert.match(lines, /不要盲目重试/)
  assert.ok(lines.includes('完成 2/3'))
})
await test('dry runs and plans are not counted as completed writes', () => {
  assert.equal(inspect({ status: 'completed', dryRun: true }).outcome, 'planned')
  assert.equal(inspect({ status: 'planned' }).outcome, 'planned')
  assert.equal(inspect({ status: 'completed', failed: 1 }).outcome, 'partial')
})
await test('pagination and audit omissions stay observations, not new tool requests', () => {
  const store = createActivityStore()
  store.observe('one', call(1))
  store.observe('one', result(2, 'a', { status: 'completed', complete: false, omitted: 18, nextOffset: 20 }))
  const row = store.snapshot('one').recent[0]
  assert.equal(row.omitted, 18); assert.equal(row.nextOffset, 20)
  const text = activityLines(store.snapshot('one'), 'en', 30).join('\n')
  assert.match(text, /Details omitted 18/)
  assert.equal(store.snapshot('one').total, 1)
})
await test('shell stdout, foreign tools and spill previews cannot fabricate native business success', () => {
  const data = result(2, 'a', { status: 'completed' }).data
  for (const tool of ['ops_bash', 'ops_run', 'ops_job_output', 'other']) assert.equal(resultDetails(tool, data, false).outcome, 'unconfirmed')
  data.message.content.push({ type: 'text', text: 'spill locator' })
  assert.equal(resultDetails('ops_grep', data, false).outcome, 'unconfirmed')
  for (const text of ['not JSON', 'null', '[]', '123']) {
    assert.equal(resultDetails('ops_grep', { content: [{ type: 'text', text }] }, true).outcome, 'unconfirmed')
  }
})
await test('parsing enforces serialized UTF-8 bytes, including exact-limit and multibyte cases', () => {
  const base = JSON.stringify({ status: 'completed', padding: '' })
  const exact = base.replace('"padding":""', '"padding":"' + 'x'.repeat(65536 - Buffer.byteLength(base)) + '"')
  assert.equal(Buffer.byteLength(exact), 65536)
  const parse = text => resultDetails('ops_glob', { content: [{ type: 'text', text }] }, true)
  assert.equal(parse(exact).outcome, 'completed')
  assert.equal(parse(exact + ' ').outcome, 'unconfirmed')
  assert.equal(parse(exact.replace('x', '汉')).outcome, 'unconfirmed')
})
await test('only bounded codes, booleans and safe nonnegative counters survive projection', () => {
  const detail = inspect({ status: 'error', total: -1, failed: 1.5, done: 2, omitted: Number.MAX_VALUE,
    error: { code: 'POLICY_DENIED', message: 'PRIVATE_ERROR', nextAction: 'PRIVATE_ACTION' },
    items: [{ path: 'PRIVATE_PATH', content: 'PRIVATE_FILE' }], raw: 'PRIVATE_TEXT' })
  assert.equal(detail.total, undefined); assert.equal(detail.failed, undefined)
  assert.equal(detail.omitted, undefined); assert.equal(detail.done, 2)
  assert.equal(detail.errorCode, 'POLICY_DENIED')
  assert.equal(JSON.stringify(detail).includes('PRIVATE'), false)
  assert.ok(Object.isFrozen(detail))
  assert.equal(inspect({ error: { code: 'bad\ncode' } }).errorCode, undefined)
})
await test('untrusted result payload shapes remain unconfirmed without retaining or throwing on them', () => {
  for (const data of [null, undefined, false, 1, 'PRIVATE_BODY', [], { message: null }, { message: { content: [null] } }]) {
    assert.deepEqual(resultDetails('ops_grep', data, false), { outcome: 'unconfirmed' })
  }
})
report('TUI result diagnostics')
