/**
 * The remedy a failed spawn of the plugin's own bash deserves.
 *
 * It lives apart from `lib/shells/publish.js` so that the tool definition
 * (`lib/shells/tool.js`) can render a spawn failure without importing the module
 * that publishes the tool. Those two used to import each other; a definition and
 * its publisher in one cycle is a load-order question nobody should have to
 * answer twice, so the remedy sits below both of them.
 *
 * @module dsh-ops/shells/spawn-error
 */

import fs from 'node:fs'
import { errorMessage } from './types.js'
import { GENERIC_BASH_REMEDY } from './paths.js'

/**
 * The directory one spawn was told to run in, when it is no longer usable.
 *
 * A missing cwd and a missing executable both surface as one ENOENT: the host
 * runner maps the platform's file-/path-not-found onto a single code, so the
 * cause cannot be read off the error. The directory is checked directly, at the
 * moment of the failure, because that is the only fact available that tells the
 * two apart (#180); a directory that became a file or a link is gone for this
 * purpose as well.
 * @param {unknown} workdir - the cwd handed to `ctx.subprocess.spawn`.
 * @returns {boolean} whether a workdir was named and is no longer a directory.
 */
function workdirIsGone(workdir: unknown) {
  if (typeof workdir !== 'string' || workdir === '') return false
  try {
    return fs.statSync(workdir, { throwIfNoEntry: false })?.isDirectory() !== true
  } catch {
    return true
  }
}

/**
 * The one remedy two rungs share: the machine's own bash is not a registry
 * artifact, so "fetch it from the registry" is not the advice it needs.
 */
const SYSTEM_BASH_SPAWN_REMEDY = 'The system bash this deployment fell back to is gone; '
  + 'reinstall it, or run `dsh-ops provision-shells --bash` for a copy the registry cannot take away.'

/**
 * The remedy one ENOENT deserves, chosen by where the executable came from.
 *
 * All of these are "the file was there when the rung resolved and is gone now",
 * but they are restored by different actions: `bundled` by the profile's own
 * dependencies, `provisioned` by running the provisioner again, `config` by the
 * operator fixing the path they typed, and `path`/`well-known` by the machine's
 * own bash. The single sentence this replaced told all of them to repair the
 * profile installation, so most were sent somewhere that could not help.
 * @type {Readonly<Record<string, string>>}
 */
const BASH_SPAWN_REMEDY: Readonly<Record<string, string>> = Object.freeze({
  bundled: "The bundled bash left the profile after it was resolved; restore the profile's "
    + 'dependencies, or run `dsh-ops provision-shells --bash` to fetch the pinned copy from '
    + 'upstream releases instead.',
  provisioned: 'The provisioned copy under this DSH_HOME is gone; run '
    + '`dsh-ops provision-shells --bash` again to reinstall the pinned upstream copy.',
  config: 'The configured bashPath no longer exists; point bashPath at a real executable, or '
    + 'clear it and run `dsh-ops provision-shells --bash`.',
  path: SYSTEM_BASH_SPAWN_REMEDY,
  'well-known': SYSTEM_BASH_SPAWN_REMEDY,
})

/**
 * The remedy for a source this table has never seen (D8).
 *
 * `source` is a closed set today, but it is a string that reaches here from the
 * resolution: a future rung must degrade to a line that is still actionable
 * rather than to no advice at all, and it must not throw on the way.
 */
const DEFAULT_BASH_SPAWN_REMEDY = `${GENERIC_BASH_REMEDY}.`

/**
 * Convert an infrastructure spawn failure into a concise model-facing result.
 *
 * Only ENOENT is source-routed: it is the one failure that means "this exact
 * executable vanished", and what to do about it depends entirely on which rung
 * supplied it. Every other spawn failure keeps the plain message, because the
 * rung is not the interesting part of it.
 * @param {unknown} error - the failure `ctx.subprocess.spawn` raised.
 * @param {string} file - the executable the rung resolved.
 * @param {string} source - where that executable came from.
 * @param {string} [workdir] - the directory the spawn was told to run in.
 * @returns {string} the model-facing error text.
 */
export function formatBashSpawnError(error: unknown, file: string, source: string, workdir?: string) {
  const errorCode = (typeof error === 'object' && error !== null || typeof error === 'function') && 'code' in error ? error.code : undefined
  const code = typeof errorCode === 'string' ? ` (${errorCode})` : ''
  if (errorCode === 'ENOENT') {
    // Name what is actually missing. A cwd that disappeared between the pre-spawn check and the
    // spawn is the case #180 reported: the payload remedy below sent the caller to reinstall bash
    // when the session's own directory had gone away.
    if (workdirIsGone(workdir)) {
      return `bash working directory is unavailable${code}: ${workdir}. The directory this command was to run in no longer exists; recreate it, or pass a workdir that exists, and retry. This is not a missing bash payload.`
    }
    const remedy = Object.hasOwn(BASH_SPAWN_REMEDY, source)
      ? BASH_SPAWN_REMEDY[source]
      : DEFAULT_BASH_SPAWN_REMEDY
    return `bash executable is unavailable${code}: ${file}. ${remedy}`
  }
  return `bash could not be started${code}: ${errorMessage(error)}`
}
