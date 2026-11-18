/**
 * Publishing the tools that run on the plugin's own shells, and the remedies a
 * spawn failure deserves.
 *
 * Legacy helper for direct callers; component mounts use mountSessionBash and
 * its scoped host-compatible definition instead. It returns the disposer for registrations
 * (today: the `ops_bash` tool backed by the plugin's own bash). Returning a
 * no-op disposer is valid.
 *
 * Why L2 publishes a tool instead of configuring an executor: `bash-local` has
 * no executable field (`packages/shell/bash-local/src/index.ts` — its `Config`
 * is `cwd`/`timeoutMs`/`maxTimeoutMs`/`maxOutputBytes`/`maxSpillBytes`/
 * `graceMs` only), so the only zero-internal-dependency way to run the plugin's
 * own bash is to publish `ops_bash` ourselves and execute through
 * `ctx.subprocess`. PowerShell stays owned by the host; OPS neither supplies an
 * executable nor rewrites the host executor configuration.
 *
 * A rung that is unavailable publishes nothing and reports why through the
 * context logger; it never throws, because a deployment without bash must still
 * load this plugin.
 *
 * @module dsh-ops/shells/publish
 */

import type { Context } from '../adapter/dsh/types.js'
import type { ResolvedConfig } from '../config.js'
import type { ShellResolution } from './paths.js'
import { errorMessage } from './types.js'
import { BASH_TOOL_NAME } from './constants.js'
import { bashToolDefinition } from './tool.js'

/**
 * Report one load-time shell problem without letting a hostile logger hide it.
 * @param {object} ctx - a Cordis context.
 * @param {string} message - the report.
 * @returns {void}
 */
function reportShellProblem(ctx: Context, message: string) {
  const logger = ctx?.logger
  if (typeof logger?.warn === 'function') {
    logger.warn(message)
    return
  }
  if (typeof logger?.error === 'function') {
    logger.error(message)
    return
  }
  console.warn(message)
}

/**
 * Publish the tools that run on the plugin's own shells.
 *
 * Today that is exactly one tool — `ops_bash`, bound to the resolved bash — and
 * nothing else: the host owns PowerShell and its executable selection. A rung
 * that is unavailable publishes nothing and reports why through the context
 * logger; it never throws, because a deployment without bash must still load
 * this plugin.
 * @param {object} ctx - a Cordis context carrying the tool registry.
 * @param {import('../config.js').ResolvedConfig} config - the plugin configuration.
 * @param {{bash: import('./paths.js').ShellResolution, pwsh: import('./paths.js').ShellResolution}} shells - the resolution to publish for.
 * @returns {() => void} the disposer for every registration made here.
 */
export function publishShellTools(ctx: Context, config: Pick<ResolvedConfig, 'publishBashTool'>, shells: { bash: ShellResolution; pwsh: ShellResolution }) {
  if (config?.publishBashTool === false) return () => {}
  const bash = shells?.bash
  if (bash === undefined || bash.available !== true || typeof bash.file !== 'string') {
    const reason = bash?.detail ?? 'the bash rung was not resolved'
    reportShellProblem(ctx, `dsh-ops: the plugin's own bash is unavailable (${reason}); `
      + `${BASH_TOOL_NAME} is not published.`)
    return () => {}
  }

  const registry = ctx?.get?.('tools')
  if (registry === undefined || typeof registry.register !== 'function') {
    reportShellProblem(ctx, `dsh-ops: no tool registry (ctx.tools) is mounted; `
      + `${BASH_TOOL_NAME} was not published.`)
    return () => {}
  }
  // Reaching the host service through `ctx.get` keeps this module free of any
  // `@deepseek-ai/*` value import while still running every command through the
  // harness's own credential scrub and process governance.
  //
  // This check gates the REGISTRATION, not just the call: without the
  // subprocess service the tool could be published and then fail on every
  // invocation, and a deployment whose ladder advertises rung two for a tool
  // that cannot run is worse than one that admits the rung is missing.
  const subprocess = ctx?.get?.('subprocess')
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    reportShellProblem(ctx, `dsh-ops: no subprocess service (ctx.subprocess) is mounted, so the `
      + `resolved bash (${bash.source}) cannot be run; ${BASH_TOOL_NAME} is not published.`)
    return () => {}
  }

  let dispose
  try {
    dispose = registry.register(bashToolDefinition({ file: bash.file, source: bash.source, subprocess }))
  } catch (error) {
    // A registry conflict (a foreign `ops_bash`) or a schema rejection is
    // reported and skipped: it must not fail plugin activation.
    reportShellProblem(ctx, `dsh-ops: ${BASH_TOOL_NAME} could not be registered `
      + `(${errorMessage(error)}).`)
    return () => {}
  }
  if (typeof dispose !== 'function') return () => {}
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    dispose()
  }
}
