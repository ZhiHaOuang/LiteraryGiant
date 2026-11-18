#!/usr/bin/env node
/**
 * The source size gate: every tracked code file stays at or under 1000 lines.
 *
 * WHY A FILE-LEVEL LIMIT. A module that crosses a thousand lines is no longer
 * read as one thing: reviewers skim it, imports of one helper drag in the whole
 * file, and a test that wants four of its functions links the rest. The rule is
 * mechanical on purpose — it can be checked without judgement, so it is checked
 * on every pull request instead of being rediscovered in review.
 *
 * WHAT COUNTS AS CODE. A file whose extension is in {@link CODE_EXTENSIONS} and
 * which is tracked by git. Prose (markdown), data (JSON), the lockfile, and
 * generated or vendored trees are out of scope: their length is not a design
 * decision this repository makes, and the lockfile and `native/target` are not
 * even written by hand.
 *
 * IT READS THE TREE, NOT A LIST. The file set comes from `git ls-files`, so a
 * new module is in scope the moment it is added — there is no inventory to
 * forget to update, and no way to opt a file out by leaving it off a list. The
 * only exclusions are directory prefixes, and they are named below.
 *
 * USAGE.
 *   node scripts/check-file-size.mjs [--limit <n>] [--json]
 *
 * Exit codes: 0 when every code file is at or under the limit, 1 when at least
 * one is over, 2 when the file list itself could not be produced.
 *
 * @module dsh-ops/scripts/check-file-size
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The line budget for one code file. The whole point of the gate. */
const DEFAULT_LIMIT = 1000

/**
 * Extensions this gate treats as source code. Kept to the languages this
 * repository actually writes, so a new asset format cannot silently join the
 * budget: adding one here is a deliberate act.
 */
const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts',
  '.rs', '.ps1', '.sh', '.py', '.cpp', '.h', '.hpp', '.cc',
])

/**
 * Directory prefixes whose files are never hand-written source. `native/target`
 * is Cargo's build directory, `runtime` is staged output, `licenses` and
 * `docs` are prose and third-party text, `node_modules` is installed rather
 * than committed, and `dist` is release output.
 */
const SKIPPED_PREFIXES = Object.freeze([
  'node_modules/',
  'native/target/',
  'runtime/',
  'licenses/',
  'docs/',
  'dist/',
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse the two flags this gate accepts. Anything unknown is a usage error: a
 * typo that silently disables the check is worse than a failed run.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{limit: number, json: boolean}} the parsed options.
 */
function parseArgs(argv) {
  let limit = DEFAULT_LIMIT
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') { json = true; continue }
    if (arg === '--limit') {
      const raw = argv[index + 1]
      index += 1
      if (raw === undefined || !/^[0-9]+$/.test(raw) || Number(raw) === 0) {
        throw new Error('--limit takes a positive integer')
      }
      limit = Number(raw)
      continue
    }
    throw new Error('unknown argument: ' + arg)
  }
  return { limit, json }
}

/**
 * Every tracked path, in git order. `-z` keeps a filename containing a newline
 * from being split into two entries.
 * @returns {string[]} repository-relative paths.
 */
function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return output.toString('utf8').split('\u0000').filter((name) => name.length > 0)
}

/**
 * Count the lines of one file the way `wc -l` does: newline characters. A file
 * with no trailing newline still counts its last line.
 * @param {Buffer} buffer - the file's bytes.
 * @returns {number} the line count.
 */
function countLines(buffer) {
  if (buffer.length === 0) return 0
  let lines = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) lines += 1
  }
  if (buffer[buffer.length - 1] !== 0x0a) lines += 1
  return lines
}

/**
 * Measure every in-scope file. Binary files are skipped: a PNG has no lines,
 * and a stray NUL byte in a source file is a problem for another gate.
 * @returns {{file: string, lines: number}[]} measurements, longest first.
 */
function measure() {
  const measured = []
  for (const file of trackedFiles()) {
    if (SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue
    if (!CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const absolute = path.join(root, file)
    let buffer
    try {
      buffer = fs.readFileSync(absolute)
    } catch {
      continue
    }
    if (buffer.includes(0)) continue
    measured.push({ file, lines: countLines(buffer) })
  }
  measured.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file))
  return measured
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error('check-file-size: ' + error.message)
  process.exit(2)
}

let measured
try {
  measured = measure()
} catch (error) {
  console.error('check-file-size: cannot list tracked files: ' + error.message)
  process.exit(2)
}

const offenders = measured.filter((entry) => entry.lines > options.limit)

if (options.json) {
  process.stdout.write(JSON.stringify({ limit: options.limit, checked: measured.length, offenders }, null, 2) + '\n')
  process.exit(offenders.length === 0 ? 0 : 1)
}

if (offenders.length === 0) {
  const longest = measured[0]
  const longestText = longest === undefined ? 'n/a' : longest.file + ' (' + longest.lines + ')'
  console.log('check-file-size: ' + measured.length + ' code file(s) checked, all at or under ' + options.limit + ' lines (longest: ' + longestText + ')')
  process.exit(0)
}

console.error('check-file-size: ' + offenders.length + ' code file(s) over ' + options.limit + ' lines:')
for (const entry of offenders) console.error('  ' + String(entry.lines).padStart(6) + '  ' + entry.file)
console.error('Split the file, or move a cohesive part of it into its own module. The limit is per file, not per directory.')
process.exit(1)
