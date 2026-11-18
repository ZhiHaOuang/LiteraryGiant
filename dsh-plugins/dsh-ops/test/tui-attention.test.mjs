import { anomalyLevel, createAttentionStore, ALERT_CAP } from '../lib/tui/attention.js'
import { assert, test, report } from './lib/harness.mjs'

await test('only actionable anomalies notify; unknown effects and transport failures have error severity', () => {
  for (const outcome of ['completed', 'planned', 'unconfirmed', undefined]) assert.equal(anomalyLevel({ status: 'returned', outcome }), undefined)
  for (const outcome of ['rejected', 'partial']) assert.equal(anomalyLevel({ status: 'returned', outcome }), 'warning')
  for (const outcome of ['unknown', 'error']) assert.equal(anomalyLevel({ status: 'returned', outcome }), 'error')
  assert.equal(anomalyLevel({ status: 'error', outcome: 'unconfirmed' }), 'error')
})
await test('aggregate acknowledgement is explicit and never downgrades earlier unread errors', () => {
  const store = createAttentionStore(), empty = store.snapshot()
  assert.equal(store.acknowledge(), false)
  store.observe({ outcome: 'rejected' }); assert.deepEqual(store.snapshot(), { level: 'warning', unread: 1, capped: false })
  store.observe({ outcome: 'unknown' }); store.observe({ outcome: 'partial' })
  assert.equal(store.snapshot().level, 'error'); assert.equal(store.snapshot().unread, 3)
  assert.ok(Object.isFrozen(store.snapshot())); assert.equal(empty.unread, 0)
  store.acknowledge(); assert.equal(store.snapshot(), empty)
  store.observe({ outcome: 'partial' }); assert.equal(store.snapshot().level, 'warning')
})
await test('constant-memory notifications saturate honestly and never retain row content or identities', () => {
  const store = createAttentionStore()
  for (let index = 0; index < ALERT_CAP; index++) store.observe({ outcome: 'partial', id: 'PRIVATE_ID', name: 'PRIVATE_NAME', arguments: 'PRIVATE_ARGS' })
  assert.equal(store.snapshot().unread, ALERT_CAP); assert.equal(store.snapshot().capped, false)
  store.observe({ outcome: 'unknown' })
  assert.deepEqual(store.snapshot(), { level: 'error', unread: ALERT_CAP, capped: true })
  const stable = store.snapshot(); let notified = 0; store.subscribe(() => notified++)
  assert.equal(store.observe({ outcome: 'partial' }), true); assert.deepEqual(store.snapshot(), stable)
  assert.equal(notified, 1, 'new alerts must relight a host-cleared badge even at the count cap')
  assert.equal(JSON.stringify(store.snapshot()).includes('PRIVATE'), false)
})
await test('subscribers and disposal stay isolated and never turn alerts into tool actions', () => {
  const store = createAttentionStore(); let updates = 0
  store.subscribe(() => { throw new Error('isolated') })
  const off = store.subscribe(() => updates++)
  store.observe({ outcome: 'completed' }); assert.equal(updates, 0)
  store.observe({ outcome: 'error' }); assert.equal(updates, 1)
  off(); store.acknowledge(); assert.equal(updates, 1)
  store.dispose(); assert.equal(store.snapshot().unread, 0)
  assert.equal(store.observe({ outcome: 'unknown' }), false); assert.equal(store.acknowledge(), false)
})
report('TUI aggregate attention')
