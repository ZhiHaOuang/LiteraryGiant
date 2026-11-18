/**
 * Package-wide locations: the installed package root and the DSH home.
 *
 * @module dsh-ops/paths
 */

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root (`lib/`'s parent). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The DSH home directory this deployment uses.
 * @param {NodeJS.ProcessEnv} [env] - the environment to read.
 * @returns {string} the absolute DSH home.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env) {
  return env.DSH_HOME && env.DSH_HOME.trim() !== ''
    ? path.resolve(env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}
