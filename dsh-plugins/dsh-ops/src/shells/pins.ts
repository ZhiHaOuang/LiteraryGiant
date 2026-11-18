/**
 * The upstream releases each bundled shell is pinned to, and the store the
 * provisioned copies live in.
 *
 * The binaries themselves are not redistributed: {@link SHELL_UPSTREAM_PINS}
 * names the upstream release and digest each shell is pinned to, and
 * `dsh-ops provision-shells` is what turns those pointers into a local,
 * digest-checked copy.
 *
 * **A POSIX host has no pinned copy, on purpose.** The table exists because a
 * Windows host carries no POSIX shell of its own, so this distribution has to
 * pin, download and digest-check one. A Linux host already has a
 * distribution-maintained bash whose ABI is tied to that distribution's libc and
 * architecture; a second, separately-updated copy would add a licensing and
 * supply-chain burden without solving anything. Linux therefore resolves the
 * machine's own bash — `config.bashPath`, then `PATH`, then
 * `POSIX_BASH_WELL_KNOWN` in `lib/shells/paths.js` — and never provisions a
 * plugin-owned one. That
 * is a deployment decision rather than a pin, so `allowSystemShellFallback` (the
 * Windows gate on reaching outside the pinned payload) deliberately does not
 * apply there: on POSIX the system bash IS the rung. Confined modes still
 * require a host sandbox, and `lib/session-shells.js` refuses the call rather
 * than executing unrestricted when one is absent.
 *
 * @module dsh-ops/shells/pins
 */

import path from 'node:path'
import { dshHome } from '../paths.js'

export type ShellKind = 'bash' | 'pwsh'

/**
 * The platform packages a deployment MAY carry a shell in, and the subdirectory
 * each keeps its shell in. Nothing requires them: the pinned upstream download
 * (`dsh-ops provision-shells`) is the route that needs no package at all, and
 * this layout is still probed so a deployment that installed one — or a checkout
 * that vendors its own copy — is honoured. `BUNDLED_LAYOUT_ORDER` in
 * `lib/shells/paths.js` names the order of the two bundled layouts.
 */
export const PLATFORM_PACKAGES = Object.freeze({
  bash: { prefix: '@dsh-ops/bash-', executable: 'bash.exe', vendor: 'bash' },
  pwsh: { prefix: '@dsh-ops/pwsh-', executable: 'pwsh.exe', vendor: 'pwsh' },
})

/**
 * The file name one shell has on a platform.
 *
 * Upstream hardcoded `bash.exe` / `pwsh.exe` at every layout, which is only true
 * on Windows: a POSIX build of either shell carries no extension. The frozen
 * table above keeps the Windows names so its published meaning is unchanged;
 * this function is the one place that knows a platform adds nothing.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} [platform] - `process.platform`.
 * @returns {string} the executable's file name.
 */
export function shellExecutable(kind: ShellKind, platform: string = process.platform) {
  return platform === 'win32' ? PLATFORM_PACKAGES[kind].executable : kind
}

/**
 * The upstream release each bundled shell is pinned to.
 *
 * THIS TABLE IS THE SINGLE SOURCE for "which upstream bytes does this
 * distribution point at". `dsh-ops provision-shells` downloads exactly these
 * assets and checks exactly these digests, and the release build imports the
 * same entries to publish the pinned facts beside the packages it assembles —
 * so a version, a URL, or a digest is edited in one place.
 *
 * - `sha256` is the digest of the archive exactly as published upstream;
 * - `executableSha256` is the digest of the file at `executableRelativePath`
 *   inside it, which the provisioner re-checks after unpacking;
 * - `extractor` says how the archive is opened (`zip` through Windows' own
 *   bsdtar, `sfx-7z` by running the archive's own self-extractor) and
 *   `extractTo` where the archive's ROOT lands inside the version directory, so
 *   the executable ends up at `<extractTo>/<file name>`.
 *
 * The two layouts differ on purpose: the PowerShell zip holds `pwsh.exe` at its
 * root and is unpacked into `bin/`, while PortableGit's self-extracting archive
 * holds the whole Git tree — `bin/bash.exe` included — and is unpacked at the
 * version root.
 */
export const SHELL_UPSTREAM_PINS = Object.freeze([
  Object.freeze({
    name: 'bash',
    label: 'Git for Windows PortableGit',
    platform: 'win32',
    arch: 'x64',
    upstreamRepo: 'https://github.com/git-for-windows/git',
    releaseTag: 'v2.56.0.windows.2',
    version: '2.56.0.2',
    assetFile: 'PortableGit-2.56.0.2-64-bit.7z.exe',
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe',
    sha256: '075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b',
    bytes: 60_027_568,
    license: 'GPL-2.0-only',
    extractor: 'sfx-7z',
    extractTo: '.',
    executableRelativePath: 'bin/bash.exe',
    executableSha256: '6cc575e9112efe6253b6a6999c12aa0240cb3f511aeda3480ae026edc0dc5280',
  }),
  Object.freeze({
    name: 'pwsh',
    label: 'PowerShell',
    platform: 'win32',
    arch: 'x64',
    upstreamRepo: 'https://github.com/PowerShell/PowerShell',
    releaseTag: 'v7.6.6',
    version: '7.6.6',
    assetFile: 'PowerShell-7.6.6-win-x64.zip',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip',
    sha256: '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860',
    bytes: 106_328_873,
    license: 'MIT',
    extractor: 'zip',
    extractTo: 'bin',
    executableRelativePath: 'bin/pwsh.exe',
    executableSha256: 'bfb46af89433268872ddb43d1ca7a3f433452ee91ed356a9786940f90118e285',
  }),
  // Added by the macOS port: Microsoft publishes the same 7.6.6 for osx-arm64 as
  // a gzipped tar whose ROOT is the payload, so it unpacks into `bin/` exactly
  // like the Windows zip and `bin/pwsh` is the executable the ladder probes.
  Object.freeze({
    name: 'pwsh',
    label: 'PowerShell',
    platform: 'darwin',
    arch: 'arm64',
    upstreamRepo: 'https://github.com/PowerShell/PowerShell',
    releaseTag: 'v7.6.6',
    version: '7.6.6',
    assetFile: 'powershell-7.6.6-osx-arm64.tar.gz',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/powershell-7.6.6-osx-arm64.tar.gz',
    sha256: '6df833d094ebac1c1a74340d7b3437f4aaf5e03ce640484a1c4359f3ce8b3db1',
    bytes: 70_604_356,
    license: 'MIT',
    extractor: 'tar.gz',
    extractTo: 'bin',
    executableRelativePath: 'bin/pwsh',
    executableSha256: '86966ef5e53763c0d7cac9981b9b36c30245185dc347ca69ddfb815c665bf515',
  }),
])

/**
 * The pin for one shell on one platform.
 * @param {object} options - the lookup.
 * @param {'bash'|'pwsh'} options.kind - which shell.
 * @param {string} [options.platform] - `process.platform`.
 * @param {string} [options.arch] - `process.arch`.
 * @returns {object|undefined} the pin, or undefined when this platform has none.
 */
export function shellUpstreamPin({ kind, platform = process.platform, arch = process.arch }: { kind: ShellKind; platform?: string; arch?: string }) {
  return SHELL_UPSTREAM_PINS.find((pin) => (
    pin.name === kind && pin.platform === platform && pin.arch === arch
  ))
}

/**
 * The provisioned-shell store: where `dsh-ops provision-shells` installs the
 * copies the plugin prefers over anything the machine happens to have.
 * @param {object} [options] - resolution inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read `DSH_HOME` from.
 * @returns {string} the absolute directory (`<DSH_HOME>/dsh-ops/shells`).
 */
export function provisionedShellStore({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  return path.join(dshHome(env), 'dsh-ops', 'shells')
}

/**
 * The version directory one pin provisions into.
 * @param {object} options - resolution inputs.
 * @param {'bash'|'pwsh'} options.kind - which shell.
 * @param {string} options.version - the pin's version.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read `DSH_HOME` from.
 * @returns {string} the absolute directory (`<store>/<name>/<version>`).
 */
export function provisionedShellVersionDir({ kind, version, env = process.env }: { kind: ShellKind; version: string; env?: NodeJS.ProcessEnv }) {
  return path.join(provisionedShellStore({ env }), kind, version)
}
