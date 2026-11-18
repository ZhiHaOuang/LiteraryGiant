/**
 * Another plugin may replace the host's running words with its own line. The
 * waiting line stands down only while a visible, readable replacement owns the
 * words, and never mistakes its own hiding of them for someone else's.
 *
 * @capability waiting-line
 * @features chat-wait
 * @risk With another status plugin installed, the running row shows two status lines on top of each other, or none at all.
 */
import { afterEach, expect, test } from 'vitest'
import { foreignRunningLineOwns } from '@dsh-claude-style/client/pure'

/** The mark the skin puts on the host words it hides; the function is told which one it is. */
const OWN_MARK = 'data-test-own-words'
const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** The host words, the skin's own line and another plugin's replacement, under a sheet hiding what each side hides. */
function attach() {
  const style = document.createElement('style')
  style.textContent = `[${OWN_MARK}], .external-running-words { display: none }`
  const content = document.createElement('span')
  const words = document.createElement('span')
  words.textContent = 'Host status'
  const ownLine = document.createElement('span')
  ownLine.textContent = 'Theme status'
  const replacement = document.createElement('div')
  replacement.textContent = 'External status'
  content.append(words, ownLine, replacement)
  document.head.append(style)
  document.body.append(content)
  cleanups.push(() => { content.remove(); style.remove() })
  return { words, ownLine, replacement }
}

test('a visible sibling alone does not take over our own hiding of the host words', () => {
  const { words, ownLine } = attach()
  words.setAttribute(OWN_MARK, '')
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
  expect(words.hasAttribute(OWN_MARK)).toBe(true)
  expect(words.checkVisibility()).toBe(false)
})

test('an inline replacement takes over before or after our line mounts', () => {
  const { words, ownLine } = attach()
  words.style.display = 'none'
  ownLine.remove()
  expect(foreignRunningLineOwns(words, undefined, OWN_MARK)).toBe(true)
  words.after(ownLine)
  words.setAttribute(OWN_MARK, '')
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(true)
  expect(words.hasAttribute(OWN_MARK)).toBe(true)
})

test('external CSS still hides the words while our own marker is excluded', () => {
  const { words, ownLine } = attach()
  words.className = 'external-running-words'
  words.setAttribute(OWN_MARK, '')
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(true)
  words.className = ''
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
})

test.each(['display:none', 'visibility:hidden', 'opacity:0'])('a replacement hidden by %s does not take over', (hidden) => {
  const { words, ownLine, replacement } = attach()
  words.style.display = 'none'
  replacement.style.cssText = hidden
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
})

test('decoration and empty or hidden text do not take over', () => {
  const { words, ownLine, replacement } = attach()
  words.style.display = 'none'
  replacement.setAttribute('aria-hidden', 'true')
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
  replacement.removeAttribute('aria-hidden')
  replacement.textContent = ' '
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
  const hiddenText = document.createElement('span')
  hiddenText.hidden = true
  hiddenText.textContent = 'Hidden status'
  replacement.append(hiddenText)
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
})

test('removing the external line or restoring the host words releases ownership', () => {
  const { words, ownLine, replacement } = attach()
  words.style.display = 'none'
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(true)
  replacement.hidden = true
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
  replacement.hidden = false
  words.style.removeProperty('display')
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
  words.style.display = 'none'
  replacement.remove()
  expect(foreignRunningLineOwns(words, ownLine, OWN_MARK)).toBe(false)
})
