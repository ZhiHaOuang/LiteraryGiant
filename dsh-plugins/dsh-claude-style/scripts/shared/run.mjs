/**
 * run.mjs — the command runner the release tools share.
 *
 * One process at a time, its stdout returned, run through a shell so a bare
 * `npm` resolves to `npm.cmd` on Windows; the arguments are quoted here rather
 * than left to the shell. Everything runs in the directory the caller names,
 * which is the repository for `scripts/release-pack.mjs` and
 * `scripts/release-state.mjs`, and the repository with the scratch tree
 * overriding it for the git calls in `scripts/dist-branch.mjs`.
 */
import { execFileSync } from 'node:child_process'

/** A `run(command, args, options?)` that starts in `root` and returns stdout. */
export function runner(root) {
  // A value the shell reads as itself. Everything else is quoted, because the
  // line goes through a shell: `git for-each-ref --format=%(objectname)` is a
  // syntax error in /bin/sh, and a path with a space would split in two.
  const safe = /^[A-Za-z0-9_@%+=:,./-]+$/
  const quote = (value) => safe.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`
  return (command, args, options = {}) => {
    const line = [command, ...args.map(quote)].join(' ')
    return execFileSync(line, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: true, ...options }).trim()
  }
}
