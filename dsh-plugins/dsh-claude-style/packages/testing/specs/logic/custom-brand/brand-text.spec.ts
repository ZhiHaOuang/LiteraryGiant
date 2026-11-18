/**
 * The reader's own brand: the name they type is drawn by the stylesheet as a
 * CSS string, and text on their accent fill takes whichever canvas ink reads
 * better on it.
 *
 * @capability custom-brand
 * @features brand
 * @risk A brand name holding a quote or a backslash breaks the sidebar's brand line, or text on a custom accent button becomes unreadable.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { accentInk, cssString } from '@dsh-claude-style/client/pure'

const INK_DARK = '#191919'
const INK_LIGHT = '#faf9f5'

test('the brand name becomes a CSS string that keeps quotes and backslashes and reads a line break as a space', () => {
  expect(cssString('Acme')).toBe('"Acme"')
  expect(cssString('Say "hi"')).toBe('"Say \\"hi\\""')
  expect(cssString('a\\b')).toBe('"a\\\\b"')
  expect(cssString('two\nlines')).toBe('"two lines"')
})

test('any printable name the reader types is a string the stylesheet draws back unchanged', () => {
  // The browser re-serialises the string it parsed, escaping exactly the quote
  // and the backslash, so a value that parsed whole reads back as written.
  const sheet = document.createElement('style')
  sheet.textContent = '.probe::after { content: var(--probe-name) }'
  const probe = document.createElement('div')
  probe.className = 'probe'
  document.head.append(sheet)
  document.body.append(probe)
  try {
    const typed = fc.array(fc.oneof(fc.string({ unit: 'grapheme-ascii', maxLength: 6 }), fc.constantFrom('\n', '"', '\\')), { maxLength: 8 }).map((parts) => parts.join(''))
    fc.assert(fc.property(typed, (name) => {
      probe.style.setProperty('--probe-name', cssString(name))
      expect(getComputedStyle(probe, '::after').content).toBe(cssString(name))
      expect(cssString(name)).not.toMatch(/[\n\r\f]/)
    }))
  } finally {
    probe.remove()
    sheet.remove()
  }
})

test('the ink on an accent fill is whichever canvas colour reads better on it', () => {
  expect(accentInk('#d97757')).toBe(INK_DARK)
  expect(accentInk('#1a7f5a')).toBe(INK_LIGHT)
  expect(accentInk('#f2c94c')).toBe(INK_DARK)
  expect(accentInk('#2b2b80')).toBe(INK_LIGHT)
})

/** WCAG contrast between two `#rrggbb` colours. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => {
      const channel = parseInt(hex.slice(at, at + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

test('on every accent the chosen ink contrasts at least as much as the other one', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 0xffffff }), (rgb) => {
    const accent = `#${rgb.toString(16).padStart(6, '0')}`
    const ink = accentInk(accent)
    const other = ink === INK_DARK ? INK_LIGHT : INK_DARK
    expect(contrast(accent, ink)).toBeGreaterThanOrEqual(contrast(accent, other))
  }))
})
