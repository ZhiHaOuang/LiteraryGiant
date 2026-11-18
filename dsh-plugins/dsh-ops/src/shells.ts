/**
 * The plugin's two shell rungs: its own bash and PowerShell 7.
 *
 * **This module is a barrel.** The implementation lives under `lib/shells/`:
 * the frozen numbers in `lib/shells/constants.js`, the upstream pins in
 * `lib/shells/pins.js`, the layout probes in `lib/shells/paths.js`, resolution
 * in `lib/shells/resolve.js`, the tool definition and renderer in
 * `lib/shells/tool.js`, and publishing in `lib/shells/publish.js`. This file
 * re-exports the public names so every existing importer keeps its import path
 * and the exported surface is unchanged.
 *
 * The two halves of the contract are {@link resolveShells}
 * (`lib/shells/resolve.js`) and {@link publishShellTools}
 * (`lib/shells/publish.js`).
 *
 * Invariants the package keeps as a whole (PLAN §2.7):
 * - the child environment is exactly the terminal overrides; credential-shaped
 *   names and `DSH_*` facts are never forwarded by it
 *   (`packages/subprocess/README.md:80`);
 * - `process.env` is read, never written; `process.chdir` is never called;
 * - a rung that cannot be resolved reports `available: false` and publishes
 *   nothing — losing the bash rung must never fail plugin activation.
 *
 * @module dsh-ops/shells
 */

export {
  BASH_ARGUMENTS,
  BASH_TOOL_NAME,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_SPILL_BYTES,
  ENV_OVERRIDES,
  MAX_BASH_TIMEOUT_MS,
  shellEnvOverrides,
} from './shells/constants.js'

export {
  PLATFORM_PACKAGES,
  SHELL_UPSTREAM_PINS,
  provisionedShellStore,
  provisionedShellVersionDir,
  shellExecutable,
  shellUpstreamPin,
} from './shells/pins.js'

export {
  BUNDLED_LAYOUT_ORDER,
  POSIX_BASH_REMEDY,
  POSIX_BASH_WELL_KNOWN,
  PWSH_LAYOUT_ORDER,
  bundledShell,
  bundledShellPath,
  preferredBundledFile,
  provisionedShell,
} from './shells/paths.js'

export { resolveShells } from './shells/resolve.js'

export {
  bashToolDefinition,
  bashToolDescription,
  renderBashResult,
  withBashStatus,
} from './shells/tool.js'

export { publishShellTools } from './shells/publish.js'

export type { ShellResolution } from './shells/paths.js'
