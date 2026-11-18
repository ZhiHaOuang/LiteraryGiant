/**
 * The plugin package's own directory, found from a module's location.
 *
 * The host half lives at `packages/host/src/` in the repository and is built to
 * `lib/host/` in the package (D73), so a module's depth is not a fixed number of
 * levels below the root: the root is the nearest directory whose `package.json`
 * carries the `dsh` field, which is the manifest the DSH loader reads.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param moduleUrl - the `import.meta.url` of a module inside the package.
 * @param packageName - the plugin's name, for the failure.
 * @returns the plugin package's directory.
 */
export function findPackageRoot(moduleUrl: string, packageName: string) {
  let at = dirname(fileURLToPath(moduleUrl))
  const top = parse(at).root
  while (at !== top) {
    const manifest = join(at, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).dsh !== undefined) return at
    at = dirname(at)
  }
  throw new Error(`${packageName}: no package.json with a dsh field above the host half`)
}
