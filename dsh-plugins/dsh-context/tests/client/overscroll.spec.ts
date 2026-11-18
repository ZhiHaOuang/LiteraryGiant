import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { containHorizontalOverscroll } from '../../src/client/overscroll'
import { wheel } from './helpers/kit'

function scroller(scrollLeft: number, clientWidth: number, scrollWidth: number): HTMLDivElement {
  const el = document.createElement('div')
  let left = scrollLeft
  Object.defineProperties(el, {
    scrollLeft: { configurable: true, get: () => left, set: (v: number) => { left = v } },
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
  })
  return el
}

describe('containHorizontalOverscroll', () => {
  test('cancels only the horizontal gestures the scroller cannot consume', () => {
    const el = scroller(100, 100, 300)
    const release = containHorizontalOverscroll(el)

    assert.equal(wheel(el, 30, 0), false, 'rightward mid-scroll')
    assert.equal(wheel(el, -30, 0), false, 'leftward mid-scroll')
    assert.equal(wheel(el, 30, 120), false, 'vertical-dominant at the edge')
    assert.equal(wheel(el, 0, 0), false, 'no horizontal component')
    el.scrollLeft = 200
    assert.equal(wheel(el, 30, 0), true, 'right edge')
    assert.equal(wheel(el, -30, 0), false, 'leftward off the right edge scrolls back')
    el.scrollLeft = 0
    assert.equal(wheel(el, -30, 0), true, 'left edge')
    assert.equal(wheel(el, 30, 0), false, 'rightward off the left edge scrolls on')
    el.scrollLeft = 199.5
    assert.equal(wheel(el, 30, 0), true, 'right edge with a fractional offset')

    release()
    assert.equal(wheel(el, 30, 0), false, 'the disposer removed the listener')
  })
})
