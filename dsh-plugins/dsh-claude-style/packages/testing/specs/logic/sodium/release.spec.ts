/**
 * Which releases a sodium member covers: the one its table entry names and
 * every later one, in the order the host and npm release by, pre-releases
 * included; a version the comparison cannot read is refused.
 *
 * @capability sodium
 * @features sodium
 * @risk The rewrite skips the host release it was checked on, or rewrites the rules of an older host whose rules it was never checked against.
 */
import { expect, test } from 'vitest'
import { SODIUM_MEMBERS, versionAtLeast } from '@dsh-claude-style/client/pure'

test('a release at or after the lowest one is covered, an earlier one is not', () => {
  expect(versionAtLeast('0.2.1-rc.2', '0.2.1-rc.2')).toBe(true)
  expect(versionAtLeast('0.2.1-rc.10', '0.2.1-rc.2')).toBe(true)
  expect(versionAtLeast('0.2.1', '0.2.1-rc.2')).toBe(true)
  expect(versionAtLeast('0.3.0-alpha.1', '0.2.1-rc.2')).toBe(true)
  expect(versionAtLeast('1.0.0', '0.2.1-rc.2')).toBe(true)
  expect(versionAtLeast('0.2.1-rc.1', '0.2.1-rc.2')).toBe(false)
  expect(versionAtLeast('0.2.1-beta.9', '0.2.1-rc.2')).toBe(false)
  expect(versionAtLeast('0.2.0', '0.2.1-rc.2')).toBe(false)
})

test('pre-release identifiers compare numbers by value and below words', () => {
  expect(versionAtLeast('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(true)
  expect(versionAtLeast('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true)
  expect(versionAtLeast('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false)
  expect(versionAtLeast('1.0.0+build.5', '1.0.0')).toBe(true)
})

test('a version the comparison cannot read is refused', () => {
  expect(() => versionAtLeast('latest', '0.2.1')).toThrow()
  expect(() => versionAtLeast('0.2', '0.2.1')).toThrow()
})

test('every member of the table names a release the comparison reads', () => {
  for (const member of SODIUM_MEMBERS) expect(() => versionAtLeast(member.since, member.since)).not.toThrow()
})
