/**
 * virtual-modules.mjs — the modules the build generates while bundling, as
 * esbuild plugins: the feature registry from the manifests (D72), the table
 * the feature chunks share the bundle's modules through (D72) and the build's
 * own output for the browser half (D36).
 */
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'packages', 'client', 'src')

/** The manifest fields the browser half reads (FeatureRuntime in packages/client/src/core/feature.ts). */
const RUNTIME_FIELDS = ['id', 'handle', 'order', 'pref', 'prefValues', 'ungated', 'yieldsTo', 'settingsRows']

/**
 * The feature registry, `virtual:dsh-claude-style/features`: each manifest's
 * runtime fields beside its main module's `install`, or beside its chunk's
 * address for a deferred feature (D72), in install order. The manifests
 * themselves stay out of the bundle: the page reads none of their test coverage.
 *
 * A feature that declares settings rows also carries its own copy here: the
 * settings page labels those rows whether the feature is installed or not, so
 * the lines it needs cannot wait for a chunk (D72).
 *
 * @param manifests - the feature manifests in install order.
 * @param chunks - each deferred feature's chunk address, by feature id.
 */
export function featuresModule(manifests, chunks) {
  const copyOwners = manifests.filter((manifest) => manifest.settingsRows !== undefined)
  const imports = manifests.flatMap((manifest, index) => manifest.load === 'deferred' ? [] : [`import { install as install${index} } from ${JSON.stringify(`./${manifest.main}`)}`])
  for (const manifest of copyOwners) imports.push(`import COPY_${manifest.id} from ${JSON.stringify(`./features/${manifest.dir}/${manifest.dir}.copy.json`)}`)
  const entries = manifests.map((manifest, index) => {
    const fields = RUNTIME_FIELDS
      .filter((field) => manifest[field] !== undefined)
      .map((field) => `${JSON.stringify(field)}: ${JSON.stringify(manifest[field])}`)
    if (manifest.settingsRows !== undefined) fields.push(`copy: COPY_${manifest.id}`)
    if (manifest.load !== 'deferred') fields.push(`install: install${index}`)
    else {
      if (chunks[manifest.id] === undefined) throw new Error(`build: the deferred feature "${manifest.id}" has no chunk`)
      fields.push(`chunk: ${JSON.stringify(chunks[manifest.id])}`)
    }
    return `  { ${fields.join(', ')} },`
  })
  const contents = `${imports.join('\n')}\nexport const FEATURES = [\n${entries.join('\n')}\n]\n`
  return {
    name: 'features',
    setup(build) {
      build.onResolve({ filter: /^virtual:dsh-claude-style\/features$/ }, (args) => ({ path: args.path, namespace: 'features' }))
      build.onLoad({ filter: /.*/, namespace: 'features' }, () => ({ contents, loader: 'js', resolveDir: SRC }))
    },
  }
}

/**
 * The table the feature chunks resolve their shared modules from,
 * `virtual:dsh-claude-style/chunk-modules` (D72): each id a chunk imports, as
 * this bundle's own instance — a source module's namespace or a generated
 * module's, or the host package exactly as the loader's `require` hands it
 * over, so the chunk's own import helpers treat it as the bundle's do.
 *
 * @param ids - module ids (paths from the repository root, or the `virtual:` path a generated module resolves under) and host package names.
 */
export function chunkModulesModule(ids) {
  const own = ids.filter((id) => id.startsWith('packages/') || id.startsWith('virtual:'))
  const source = (id) => (id.startsWith('virtual:') ? id : path.join(ROOT, id))
  const imports = own.map((id, index) => `import * as shared${index} from ${JSON.stringify(source(id))}`)
  const entries = ids.map((id) => {
    const index = own.indexOf(id)
    return `  ${JSON.stringify(id)}: ${index === -1 ? `require(${JSON.stringify(id)})` : `shared${index}`},`
  })
  const contents = `${imports.join('\n')}\nexport const CHUNK_MODULES = {\n${entries.join('\n')}\n}\n`
  return {
    name: 'chunk-modules',
    setup(build) {
      build.onResolve({ filter: /^virtual:dsh-claude-style\/chunk-modules$/ }, (args) => ({ path: args.path, namespace: 'chunk-modules' }))
      build.onLoad({ filter: /.*/, namespace: 'chunk-modules' }, () => ({ contents, loader: 'js', resolveDir: SRC }))
    },
  }
}

/**
 * The table the settings page resolves its own row controls from,
 * `virtual:dsh-claude-style/settings-controls` (D72): each feature that draws a
 * control or a status line itself exports them from `<功能>.settings.ts` beside its main module,
 * and the settings page — the only importer — carries them with its own chunk.
 *
 * @param manifests - the feature manifests in install order.
 */
export function settingsControlsModule(manifests) {
  const owners = manifests.filter((manifest) => (manifest.settingsRows ?? []).some((row) => row.control !== undefined || row.status !== undefined))
  const imports = owners.map((manifest) => `import { controls as ROWS_${manifest.id} } from ${JSON.stringify(`./features/${manifest.dir}/${manifest.dir}.settings`)}`)
  const entries = owners.map((manifest) => `  ${JSON.stringify(manifest.id)}: ROWS_${manifest.id},`)
  const contents = `${imports.join('\n')}\nexport const ROW_CONTROLS = {\n${entries.join('\n')}\n}\n`
  return {
    name: 'settings-controls',
    setup(build) {
      build.onResolve({ filter: /^virtual:dsh-claude-style\/settings-controls$/ }, (args) => ({ path: args.path, namespace: 'settings-controls' }))
      build.onLoad({ filter: /.*/, namespace: 'settings-controls' }, () => ({ contents, loader: 'js', resolveDir: SRC }))
    },
  }
}

/**
 * The generated module's source: everything the build produces for the browser
 * half, as named exports. The build serves it to the bundle and the unit tests'
 * config writes it out, so both hand a module under test the same values.
 *
 * @param values - export name → value.
 */
export function generatedSource(values) {
  return Object.entries(values).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)}`).join('\n')
}

/**
 * The generated module (packages/client/src/generated.d.ts) as an esbuild plugin: everything the
 * build produces for the browser half, as named exports.
 */
export function generatedModule(values) {
  const contents = generatedSource(values)
  return {
    name: 'generated',
    setup(build) {
      build.onResolve({ filter: /^virtual:dsh-claude-style\/generated$/ }, (args) => ({ path: args.path, namespace: 'generated' }))
      build.onLoad({ filter: /.*/, namespace: 'generated' }, () => ({ contents, loader: 'js' }))
    },
  }
}
