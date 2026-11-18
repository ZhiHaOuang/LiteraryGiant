#!/usr/bin/env node
/**
 * changelog.mjs — keep a released version's section in docs/CHANGELOG.md and print the pending one from docs/changes/ (D48).
 *
 * A change adds one small JSON file under docs/changes/ and never edits the
 * CHANGELOG: the file carries its group, where it sits in that group, whether it
 * moves an external contract, the date it landed and the entry in both
 * languages. The pending changes stay in that directory rather than in the
 * file: two branches that each add a file touch nothing in common, so merging
 * them cannot conflict on the CHANGELOG. `--release` turns them into the
 * version's section above the older ones and clears the directory; until then
 * the default prints the section the release would write, and writes nothing.
 *
 * Usage: node scripts/changelog.mjs [--check | --release <version> [--date <YYYY-MM-DD>] | --notes <version>]
 *        --check writes nothing and fails when a fragment does not validate or
 *        docs/CHANGELOG.md holds an [Unreleased] section.
 *        --release turns the pending changes into the version's section, puts it
 *        above the older ones, and clears docs/changes/.
 *        --notes prints a released version's section without its heading: the
 *        body of that version's GitHub Release.
 *        No flag prints the pending section on stdout and writes nothing.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHANGES = path.join(ROOT, 'docs', 'changes')
const FILE = path.join(ROOT, 'docs', 'CHANGELOG.md')

/** The groups in their fixed order, with the heading each language uses. */
const GROUPS = [
  { key: 'new', zh: '新增功能', en: 'New Features' },
  { key: 'improvements', zh: '体验优化', en: 'Improvements' },
  { key: 'fixes', zh: '问题修复', en: 'Bug Fixes' },
  { key: 'security', zh: '安全', en: 'Security' },
  { key: 'removals', zh: '移除', en: 'Removals' },
  { key: 'chores', zh: '其他变更', en: 'Chores' },
]

/** Every pending change, read and validated. A release clears the directory, and git keeps no empty one: no directory is no pending change. */
function readFragments() {
  const fragments = []
  if (!fs.existsSync(CHANGES)) return fragments
  for (const name of fs.readdirSync(CHANGES)) {
    // dsh-ops leaves a hidden `.dsh-ops-update-<hash>.lock` beside a file it wrote;
    // it is no fragment, and reading it as one fails every commit in this directory.
    if (name.startsWith('.')) continue
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new Error(`changelog: docs/changes/${name} is not <slug>.json`)
    const fragment = JSON.parse(fs.readFileSync(path.join(CHANGES, name), 'utf8'))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fragment.at ?? '')) throw new Error(`changelog: docs/changes/${name} needs an "at" date (YYYY-MM-DD)`)
    if (!GROUPS.some((group) => group.key === fragment.group)) throw new Error(`changelog: docs/changes/${name} has group "${fragment.group}", which is not one of ${GROUPS.map((group) => group.key).join(', ')}`)
    if (!Number.isSafeInteger(fragment.order) || fragment.order < 0) throw new Error(`changelog: docs/changes/${name} needs "order", an integer from 0, saying where it sits in its group`)
    if (typeof fragment.external !== 'boolean') throw new Error(`changelog: docs/changes/${name} needs "external" as true or false`)
    for (const language of ['zh', 'en']) {
      const text = fragment[language]
      if (typeof text !== 'string' || text.trim() === '') throw new Error(`changelog: docs/changes/${name} has no "${language}" entry`)
      if (text.includes('\n')) throw new Error(`changelog: docs/changes/${name}'s "${language}" entry must be one line`)
      if (/[：:]/.test(text)) throw new Error(`changelog: docs/changes/${name}'s "${language}" entry names the change only; take the explanatory tail off after the colon`)
    }
    fragments.push({ name, ...fragment })
  }
  return fragments.sort((a, b) => a.at === b.at ? a.name.localeCompare(b.name) : a.at.localeCompare(b.at))
}

/**
 * The section's body: the Chinese groups in order, then the English ones. The
 * first heading of each language carries the anchor that language's line points
 * at, so the anchors stay on whichever group happens to come first.
 */
function body(fragments) {
  const lines = []
  for (const [language, anchor] of [['zh', 'cn-unreleased'], ['en', 'en-unreleased']]) {
    const groups = GROUPS.filter((group) => fragments.some((fragment) => fragment.group === group.key))
    groups.forEach((group, at) => {
      const heading = language === 'zh' ? group.zh : group.en
      lines.push('', at === 0 ? `<h3 id="${anchor}">${heading}</h3>` : `### ${heading}`, '')
      const entries = fragments
        .filter((entry) => entry.group === group.key)
        .sort((a, b) => a.order === b.order ? a.name.localeCompare(b.name) : a.order - b.order)
      for (const fragment of entries) lines.push(`- ${fragment[language]}`)
    })
  }
  return lines
}

/** The pending section as the reader would see it under the next version: its heading, the language line and the groups. */
function pendingSection(fragments) {
  if (fragments.length === 0) return '## [Unreleased]\n\n'
  return `${['## [Unreleased]', '', '[中文](#cn-unreleased) | [English](#en-unreleased)', ...body(fragments)].join('\n')}\n\n`
}

/** One released version's section, anchored by its own number rather than `unreleased`. */
function releaseSection(fragments, version, date) {
  const lines = [`## [${version}] - ${date}`, '', `[中文](#cn-${version}) | [English](#en-${version})`, ...body(fragments)]
  return `${lines.join('\n').split('cn-unreleased').join(`cn-${version}`).split('en-unreleased').join(`en-${version}`)}\n\n`
}

const fragments = readFragments()
const changelog = fs.readFileSync(FILE, 'utf8')

if (process.argv.includes('--notes')) {
  const version = process.argv[process.argv.indexOf('--notes') + 1]
  const heading = `## [${version}] - `
  const at = version === undefined ? -1 : changelog.indexOf(`\n${heading}`)
  if (at === -1) throw new Error(`changelog: docs/CHANGELOG.md has no "${heading}" section`)
  const from = changelog.indexOf('\n', at + 1) + 1
  const next = changelog.indexOf('\n## [', from)
  process.stdout.write(`${changelog.slice(from, next === -1 ? changelog.length : next).trim()}\n`)
} else if (process.argv.includes('--check')) {
  if (/^## \[Unreleased\]/m.test(changelog)) {
    throw new Error('changelog: docs/CHANGELOG.md holds an [Unreleased] section; a pending change lives in docs/changes/ and `--release` writes it, so take the section out')
  }
  console.log(`changelog: ${fragments.length} pending changes, none written into docs/CHANGELOG.md`)
} else if (process.argv.includes('--release')) {
  const version = process.argv[process.argv.indexOf('--release') + 1]
  if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('changelog: --release needs a version like 0.12.0')
  const dateAt = process.argv.indexOf('--date')
  const date = dateAt === -1 ? new Date().toISOString().slice(0, 10) : process.argv[dateAt + 1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('changelog: --date needs a date like 2026-10-06')
  if (fragments.length === 0) throw new Error('changelog: docs/changes/ holds nothing to release')
  // The new section goes above the newest one, which is the first heading the
  // file's preamble is followed by; a file with none has nowhere to put it.
  const at = changelog.search(/^## \[/m)
  if (at === -1) throw new Error('changelog: docs/CHANGELOG.md has no version section to put the release above')
  fs.writeFileSync(FILE, `${changelog.slice(0, at)}${releaseSection(fragments, version, date)}${changelog.slice(at)}`)
  for (const fragment of fragments) fs.rmSync(path.join(CHANGES, fragment.name))
  console.log(`changelog: released ${fragments.length} changes as ${version} on ${date}; docs/changes/ is clear`)
} else {
  process.stdout.write(pendingSection(fragments))
  console.error(`changelog: ${fragments.length} pending changes, printed and not written; \`--release <version>\` writes them`)
}
