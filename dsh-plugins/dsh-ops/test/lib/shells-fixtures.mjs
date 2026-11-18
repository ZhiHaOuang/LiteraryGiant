/**
 * The fixtures the `shells-*` suites share: temporary executables, the two
 * staged shell layouts (the store `provision-shells` fills and the published
 * `@dsh-ops/<shell>-<platform>-<arch>` packages), and the fake tool registry
 * and subprocess service.
 *
 * Everything here is a fake by construction — temp directories, a synthetic
 * PATH, a registry that records instead of mounting, and a subprocess service
 * that never spawns — because the suites assert the contract, not this
 * machine's shells.
 *
 * The patch fixtures (`PATCH_TEXT`, `patchEntries`, the loader evaluation,
 * `stageLinkedProfile`) deliberately stay in `test/shells-patch.test.mjs`:
 * one suite reads them, and moving them here would make every other suite parse
 * `cordis.patch.yml` through `yaml` for nothing.
 *
 * @module dsh-ops/test/shells-fixtures
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../../lib/config.js'
import { provisionedShellVersionDir, shellExecutable, shellUpstreamPin } from '../../lib/shells.js'

/**
 * Make one executable file.
 * @param {string} file - absolute path.
 * @returns {string} the same path.
 */
export function makeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'stub')
  return file
}

/**
 * Stage one provisioned copy, exactly as `dsh-ops provision-shells` lays it out.
 * @param {string} home - the DSH home whose store to write into.
 * @param {'bash'|'pwsh'} kind - which shell.
 * @param {string} version - the version directory.
 * @returns {string} the executable path.
 */
export function stageProvisioned(home, kind, version) {
  const pin = shellUpstreamPin({ kind, platform: process.platform, arch: process.arch })
  // The same rule the resolver applies, so the fixture cannot disagree with the
  // store it is pretending to be: the pin's own layout, or `bin/<name on this
  // platform>` when this platform has no pin at all.
  const relative = pin?.executableRelativePath ?? path.join('bin', shellExecutable(kind, process.platform))
  return makeExecutable(path.join(provisionedShellVersionDir({ kind, version, env: { DSH_HOME: home } }), relative))
}

/**
 * The platform package one rung is carried by.
 *
 * `platform`/`arch` are parameters rather than `process.platform`: the suites run on both hosts, and
 * the cases that describe the **Windows** pinned payload (its package layout, the missing-package
 * advice, the `allowSystemShellFallback` gate) must exercise that payload wherever the suite runs.
 * A case that means "this host" passes the host's values explicitly.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @param {string} [platform] - the target platform.
 * @param {string} [arch] - the target architecture.
 * @returns {string} the package name.
 */
export function platformPackageName(kind, platform = process.platform, arch = process.arch) {
  return `@dsh-ops/${kind}-${platform}-${arch}`
}

/**
 * A configuration with every key the plugin documents, overridden per case.
 * @param {Record<string, unknown>} [overrides] - the keys to set.
 * @returns {import('../../lib/config.js').ResolvedConfig} the resolved config.
 */
export function config(overrides = {}) {
  return resolveConfig(overrides)
}

/**
 * A PATH-shaped string holding one directory.
 * @param {string} dir - the directory.
 * @returns {string} the PATH value.
 */
export function onlyPath(dir) {
  return dir
}

/**
 * Stage a bundle root whose manifest declares an optional platform package.
 * @param {string} root - the temporary plugin root.
 * @param {'bash'|'pwsh'} kind - which rung.
 * @param {{install: boolean, binary: boolean, platform?: string, arch?: string}} shape - how the package is present.
 * @returns {string} the plugin root.
 */
export function stagePlatformPackage(root, kind, { install, binary, platform = process.platform, arch = process.arch }) {
  const name = platformPackageName(kind, platform, arch)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'dsh-ops',
    version: '0.1.0',
    optionalDependencies: { [name]: '0.1.0' },
  }))
  if (!install) return root
  const packageDir = path.join(root, 'node_modules', ...name.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name, version: '0.1.0',
  }))
  if (binary) {
    makeExecutable(path.join(packageDir, 'bin', shellExecutable(kind, process.platform)))
  }
  return root
}

/**
 * A tool registry that records registrations the way the host's own does.
 * @param {object} [options] - the fakes to mount.
 * @param {object|undefined} [options.subprocess] - the subprocess service; an
 *   explicit `undefined` means this composition has none.
 * @returns {object} the fake context plus the inspection helpers.
 */
export function fakeRegistry(options = {}) {
  // A present key wins even when its value is `undefined`: "this deployment has
  // no subprocess service" is one of the cases under test.
  const subprocess = Object.hasOwn(options, 'subprocess')
    ? options.subprocess
    : { spawn() { throw new Error('not expected in this check') } }
  const live = new Map()
  const registrations = []
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get(service) {
      if (service === 'tools') {
        return {
          register(definition) {
            registrations.push(definition)
            live.set(definition.name, definition)
            return () => live.delete(definition.name)
          },
        }
      }
      if (service === 'subprocess') return subprocess
      return undefined
    },
    subprocess,
  }
  return { ctx, live, registrations, subprocess }
}

/**
 * A subprocess service that records one spawn spec and settles it on demand.
 * @param {{exitCode?: number|null, signal?: string|null, stdout?: string, stderr?: string, lossy?: boolean}} [outcome] - the settled result.
 * @returns {object} the fake service and its recorded state.
 */
export function fakeSubprocess({ exitCode = 0, signal = null, stdout = '', stderr = '', lossy = false } = {}) {
  const specs = []
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const service = {
    spawn(spec) {
      specs.push(spec)
      return {
        collected: {
          stdout: { readFrom: (from) => ({ text: from === 0 ? stdout : '', nextOffset: stdout.length, lossy }) },
          stderr: { readFrom: (from) => ({ text: from === 0 ? stderr : '', nextOffset: stderr.length, lossy: false }) },
        },
        done,
      }
    },
  }
  return { service, specs, settle: () => settle({ exitCode, signal }) }
}
