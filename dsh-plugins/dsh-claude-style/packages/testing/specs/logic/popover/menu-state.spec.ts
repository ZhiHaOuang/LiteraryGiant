/**
 * The one write that opens or closes a menu card: the card's state, its role
 * and the state its trigger reports are one act, so assistive technology and
 * the reader see the same thing.
 *
 * @capability popover
 * @features shared
 * @risk A menu stands open while its trigger still reports it collapsed, so a screen reader announces a closed menu and the reader presses the trigger twice.
 */
import { afterEach, expect, test } from 'vitest'
import { setMenuPopoverOpen } from '@dsh-claude-style/client/pure'
import { surfaceAttribute } from '../../fixtures/surface'

const OPEN = surfaceAttribute('popover.open')

afterEach(() => {
  document.body.replaceChildren()
})

function card() {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

function trigger() {
  const element = document.createElement('button')
  element.setAttribute('aria-haspopup', 'menu')
  document.body.append(element)
  return element
}

test('opening writes the card state, its role and the trigger\'s state together', () => {
  const popover = card()
  const button = trigger()
  setMenuPopoverOpen(popover, true, button)
  expect(popover.getAttribute(OPEN)).toBe('true')
  expect(popover.getAttribute('role')).toBe('menu')
  expect(button.getAttribute('aria-expanded')).toBe('true')
})

test('closing takes the role off and tells the trigger the same', () => {
  const popover = card()
  const button = trigger()
  setMenuPopoverOpen(popover, true, button)
  setMenuPopoverOpen(popover, false, button)
  expect(popover.getAttribute(OPEN)).toBe('false')
  expect(popover.getAttribute('role')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

test('a card toggled without a trigger writes nothing but its own state', () => {
  const popover = card()
  setMenuPopoverOpen(popover, true)
  expect(popover.getAttribute(OPEN)).toBe('true')
  expect(popover.getAttribute('role')).toBe('menu')
})
