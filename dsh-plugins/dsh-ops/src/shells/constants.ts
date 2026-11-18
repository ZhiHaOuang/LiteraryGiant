/**
 * The frozen constants of the plugin's two shell rungs: the model-facing tool
 * name, the budgets `ops_bash` runs with, the arguments it declares, and the
 * terminal environment its children are spawned with.
 *
 * `BASH_ARGUMENTS` is enforced by `execute` while `parameters.properties`
 * documents the same list; the two are written separately and can drift, so
 * `test/shells-bash-tool.test.mjs` pins them against each other. The two
 * timeouts and the two output caps are handed to `ctx.subprocess` verbatim.
 *
 * The child environment is exactly the overrides below and nothing else:
 * credential-shaped names and `DSH_*` facts are never forwarded by this module
 * (`packages/subprocess/README.md:80`), and `process.env` is read, never
 * written.
 *
 * @module dsh-ops/shells/constants
 */

import { BASH_TOOL } from '../policy.js'

/** Model-facing name of the tool this module publishes for the bash rung. */
export const BASH_TOOL_NAME = BASH_TOOL

/** Default foreground deadline for one `ops_bash` command, in milliseconds. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000

/** Upper bound for a per-call `timeoutMs`, in milliseconds. */
export const MAX_BASH_TIMEOUT_MS = 2_147_483_647

/**
 * Grace period handed to `ctx.subprocess` for its SIGTERM→SIGKILL escalation,
 * matching the upstream bash executor's default
 * (`packages/shell/bash-local/src/index.ts:35`).
 */
export const DEFAULT_GRACE_MS = 3_000

/** Per-stream in-memory cap, matching the upstream executor default. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/** Per-stream spill-file cap; a larger stream keeps only its in-memory tail. */
export const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/**
 * Every argument `ops_bash` declares, in schema order.
 *
 * `execute` enforces this list while `parameters.properties` documents it, and
 * the two are written separately, so they can drift: a name added to the schema
 * but not here would be refused as unknown, and a name kept here after the
 * schema drops it would silently pass through. `test/shells-bash-tool.test.mjs`
 * pins the two against each other.
 */
export const BASH_ARGUMENTS = Object.freeze(['command', 'description', 'script_path', 'workdir', 'timeoutMs', 'graceMs', 'includeDiagnostics'])

/**
 * Model-friendly environment overrides: disable colors, pagers, and interactive
 * terminal features that would garble tool output. The terminal entries are the
 * upstream bash executor's set verbatim
 * (`packages/shell/bash-local/src/index.ts:27-32`), passed as an explicit `env`,
 * which the subprocess service merges AFTER its ambient credential scrub.
 *
 * `LC_MESSAGES` is added here because `session-shells.js` classifies a sandbox
 * refusal by matching the host-supplied English `denialSignatures` against the
 * command's stderr. A localized libc prints those messages in the host's own
 * language, so on a non-English host — a `zh_CN.UTF-8` desktop, say —
 * `read-only file system` never matches `只读文件系统`, and the refusal is
 * reported as a generic command failure instead of an execution restriction. The upstream
 * DSH bash tool does not need this because its spawn already pins `LC_ALL=C`;
 * this plugin passes its own `env` and therefore has to state it.
 *
 * The change is scoped to this shell path on purpose. The PTC worker's stderr
 * comes from the Rust worker and from bubblewrap, neither of which calls
 * `setlocale`, so that path is unaffected and is left alone.
 *
 * `LC_MESSAGES` rather than `LC_ALL`: message catalogs are all that must be
 * pinned. `LC_ALL=C` would also override `LC_CTYPE`, and commands then treat
 * UTF-8 input as bytes — `wc -m` on a three-character Chinese word reports 9
 * instead of 3 — which would corrupt exactly the non-English output this plugin
 * is trying not to break. An explicit caller entry still wins, as with the rest
 * of this set.
 */
export const ENV_OVERRIDES = Object.freeze({
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  LC_MESSAGES: 'C',
})

/**
 * {@link ENV_OVERRIDES} as it must reach a spawn, given the environment it is
 * merged over.
 *
 * POSIX resolves `LC_ALL` **before** `LC_MESSAGES`, so on a host that sets
 * `LC_ALL` — a `zh_CN.UTF-8` desktop commonly sets nothing else — the pin above
 * was silently ineffective: the child's message catalog stayed localized and the
 * English `denialSignatures` stopped matching, which is the whole reason the pin
 * exists. Reported by @Haoming9527 in review of #81.
 *
 * The fix cannot be "set `LC_ALL=C`": that also overrides `LC_CTYPE`, and
 * commands then read UTF-8 input as bytes (`wc -m` counts 9 for a three-character
 * Chinese word), corrupting the non-English output this plugin is trying not to
 * break. Instead the override is neutralized — an empty value is "unset" to the
 * C library, the same rule that makes an unset variable fall through — and the
 * variable's *character-encoding* intent is carried forward as `LC_CTYPE`, which
 * only applies when the host did not state a ctype of its own.
 * @param {NodeJS.ProcessEnv} [ambient] - the environment the spawn merges over.
 * @param {NodeJS.ProcessEnv} [explicit] - the caller's own entries.
 * @returns {NodeJS.ProcessEnv} the environment to pass to the spawn.
 */
export function shellEnvOverrides(ambient: NodeJS.ProcessEnv = process.env, explicit: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ENV_OVERRIDES, ...explicit }
  const all = explicit.LC_ALL ?? ambient.LC_ALL
  if (typeof all === 'string' && all !== '') {
    env.LC_ALL = ''
    if (!(explicit.LC_CTYPE ?? ambient.LC_CTYPE)) env.LC_CTYPE = all
  }
  return env
}
