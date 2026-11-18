import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { modalStoreOf, setPendingConsume, takePendingConsume, type ConsumeGuard } from '../../src/client/modalStore'

describe('modalStoreOf', () => {
  test('returns the same store per session id, distinct stores across ids, starting closed', () => {
    assert.equal(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-a'))
    assert.notEqual(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-b'))
    assert.equal(modalStoreOf('modal-initial').getSnapshot(), false)
  })

  test('set with a flipped value notifies once per change; a repeat notifies nothing', () => {
    const store = modalStoreOf('modal-flip')
    let calls = 0
    store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    assert.equal(store.getSnapshot(), true)
    store.set(true)
    assert.equal(calls, 1)
    store.set(false)
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot(), false)
  })

  test('unsubscribe stops notifications', () => {
    const store = modalStoreOf('modal-unsub')
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    unsubscribe()
    store.set(false)
    assert.equal(calls, 1)
  })
})

describe('pending consume guards', () => {
  test('take returns the guard once, then undefined; an absent guard reads undefined', () => {
    assert.equal(takePendingConsume('consume-absent'), undefined)
    const guard: ConsumeGuard = { kind: 'bare-token', token: '/context' }
    setPendingConsume('consume-once', guard)
    assert.equal(takePendingConsume('consume-once'), guard)
    assert.equal(takePendingConsume('consume-once'), undefined)
  })

  test('guards are isolated per session', () => {
    const guard: ConsumeGuard = { kind: 'span', span: { start: 0, end: 8, draftRev: 1 } }
    setPendingConsume('consume-iso-a', guard)
    assert.equal(takePendingConsume('consume-iso-b'), undefined)
    assert.equal(takePendingConsume('consume-iso-a'), guard)
  })
})
