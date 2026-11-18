/**
 * Whether a release is the one a sodium member was checked on or a later one
 * (D78): the table names the lowest version it adapts, and every higher one is
 * included.
 *
 * The order is the semantic-versioning precedence the host and npm both
 * release by: the three numbers first, then a pre-release ranks below its
 * release, its dot-separated identifiers compared in turn — numbers by value
 * and below words, words by their characters — and a shorter list of equal
 * identifiers ranks below a longer one. Build metadata after `+` takes no part.
 *
 * @throws when either side is no such version: a table entry or a host release
 *         the comparison cannot read would otherwise decide the rewrite silently.
 */
export function versionAtLeast(version: string, lowest: string) {
  return compareVersions(parseVersion(version), parseVersion(lowest)) >= 0
}

interface ParsedVersion {
  core: [number, number, number]
  pre: string[]
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(text: string): ParsedVersion {
  const match = VERSION_RE.exec(text)
  if (match === null) throw new Error(`sodium: "${text}" is not a release version`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareVersions(a: ParsedVersion, b: ParsedVersion) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const order = compareIdentifiers(a.pre[i], b.pre[i])
    if (order !== 0) return order
  }
  return a.pre.length - b.pre.length
}

function compareIdentifiers(a: string, b: string) {
  const aNumber = /^\d+$/.test(a)
  const bNumber = /^\d+$/.test(b)
  if (aNumber && bNumber) return Number(a) - Number(b)
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}
