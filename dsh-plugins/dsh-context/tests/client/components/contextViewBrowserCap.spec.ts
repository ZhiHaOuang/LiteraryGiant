import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { browserCapOf } from '../../../src/client/components/contextView'

describe('browserCapOf — the Context browser column\'s height ceiling', () => {
  test('the card span rounded UP, and no usable measurement leaves the column uncapped', () => {
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609 }]), 509)
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609.4 }]), 510)
    assert.equal(browserCapOf([]), null, 'the loading frame measures nothing')
    assert.equal(browserCapOf([{ top: 0, bottom: 0 }]), null, 'a degenerate span')
    assert.equal(browserCapOf([{ top: 10, bottom: 5 }]), null)
    assert.equal(browserCapOf([{ top: Number.NaN, bottom: 10 }]), null, 'a layout-less stub never yields NaN')
    assert.equal(browserCapOf([{ top: 0, bottom: undefined as unknown as number }]), null)
  })
})
