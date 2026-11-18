import { createActivityStore } from '../lib/tui/activity.js'
import { activityView, ACTIVITY_FILTERS } from '../lib/tui/panel.js'
import { call, result } from './lib/activity-events.mjs'
import { assert, test, report } from './lib/harness.mjs'

function fixture(recentLimit = 8) {
  const store = createActivityStore({ recentLimit }); let seq = 0
  return { store, settle(name, value, error) {
    const id = 'row-' + seq
    store.observe('one', call(++seq, id, name)); store.observe('one', result(++seq, id, value, error))
  }, start(name = 'ops_glob') { store.observe('one', call(++seq, 'active-' + seq, name)) } }
}
await test('filters select retained rows, never cumulative statistics or business-unconfirmed returns', () => {
  const { store, settle, start } = fixture()
  for (const status of ['completed', 'planned', 'rejected', 'partial', 'unknown', 'error']) settle('ops_batch', { status })
  settle('ops_bash', { status: 'completed' }); settle('ops_grep', {}, 'PRIVATE_TRANSPORT')
  start()
  const snapshot = store.snapshot('one')
  assert.deepEqual(ACTIVITY_FILTERS, ['all', 'running', 'anomalies'])
  assert.equal(activityView(snapshot).rowCount, 9)
  const running = activityView(snapshot, 'en', 24, { filter: 'running' })
  assert.equal(running.rowCount, 1); assert.ok(running.lines.includes('ops_glob'))
  const anomalies = activityView(snapshot, 'en', 24, { filter: 'anomalies' })
  assert.equal(anomalies.rowCount, 5); assert.ok(anomalies.lines.includes('Calls 9 · Running 1'))
  assert.equal(anomalies.lines.includes('ops_bash'), false)
  assert.equal(store.snapshot('one'), snapshot, 'navigation must not mutate observer state')
})
await test('local pages expose every retained diagnostic without resurrecting evicted history', () => {
  const { store, settle } = fixture(4)
  for (let index = 0; index < 10; index++) settle('ops_replace', { status: 'error', error: { code: 'PAGE_ERROR_' + index } })
  const snapshot = store.snapshot('one'), first = activityView(snapshot, 'en', 12)
  assert.equal(first.rowCount, 4); assert.ok(first.pageCount > 1)
  const text = Array.from({ length: first.pageCount }, (_, page) => activityView(snapshot, 'en', 12, { page }).lines.join('\n')).join('\n')
  for (let index = 6; index < 10; index++) assert.ok(text.includes('PAGE_ERROR_' + index))
  for (let index = 0; index < 6; index++) assert.equal(text.includes('PAGE_ERROR_' + index), false)
  assert.ok(text.includes('Calls 10 · Running 0')); assert.equal(store.snapshot('one'), snapshot)
})
await test('long unknown-effect diagnostics continue with tool context instead of disappearing below a slice', () => {
  const { store, settle } = fixture()
  settle('ops_batch', { status: 'partial', unknown: 1, done: 2, total: 3, omitted: 4, error: { code: 'RESULT_UNKNOWN' } })
  const snapshot = store.snapshot('one'), first = activityView(snapshot, 'zh', 9)
  assert.ok(first.pageCount > 1)
  const pages = Array.from({ length: first.pageCount }, (_, page) => activityView(snapshot, 'zh', 9, { page }))
  const text = pages.flatMap(page => page.lines).join('\n')
  for (const detail of ['RESULT_UNKNOWN', '请检查副作用，不要盲目重试', '完成 2/3', '未展示明细 4']) assert.ok(text.includes(detail), detail)
  for (const page of pages) { assert.equal(page.lines.length, 9); assert.ok(page.lines.some(line => line.includes('ops_batch'))) }
})
await test('page selection clamps after filters, live retention changes and resize; tiny panels remain bounded', () => {
  const { store, settle, start } = fixture()
  for (let index = 0; index < 8; index++) settle('ops_grep', { status: 'completed' })
  start()
  const snapshot = store.snapshot('one')
  for (const height of [0, 1, 2, 6, 8, 9, 12, 24, 60]) {
    const view = activityView(snapshot, 'en', height, { page: 999 })
    assert.ok(view.lines.length <= height); assert.equal(view.page, view.pageCount - 1)
  }
  assert.equal(activityView(snapshot, 'en', 24, { page: -1 }).page, 0)
  assert.equal(activityView(snapshot, 'en', 24, { page: NaN }).page, 0)
  assert.equal(activityView(snapshot, 'en', 24, { filter: 'invalid' }).filter, 'all')
  const filtered = activityView(snapshot, 'en', 24, { filter: 'running', page: 999 })
  assert.equal(filtered.page, 0); assert.equal(filtered.pageCount, 1)
})
await test('empty filters and all-session alerts remain clearly scoped and cannot clear data', () => {
  const { store, settle } = fixture()
  settle('ops_grep', { status: 'completed' })
  const snapshot = store.snapshot('one'), alert = Object.freeze({ unread: 2, level: 'error', capped: false })
  const view = activityView(snapshot, 'en', 16, { filter: 'running', alert })
  assert.ok(view.lines.includes('No retained rows in filter')); assert.ok(view.lines.includes('All sessions · alerts 2'))
  assert.ok(view.lines.includes('Calls 1 · Running 0')); assert.equal(view.rowCount, 0)
  assert.equal(alert.unread, 2); assert.equal(store.snapshot('one'), snapshot)
  assert.equal(activityView(store.snapshot('empty')).pageCount, 1)
})
report('TUI read-only navigation')
