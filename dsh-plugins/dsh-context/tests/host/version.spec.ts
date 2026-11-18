import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { detectHarnessVersion } from '../../src/host/version'

const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

const resolverIn = (root: string) => (...segments: string[]): string => join(root, ...segments)
const homeResolver = (home: string): (...segments: string[]) => string => resolverIn(join(HOMES, home))

function ctxWithHome(homePath: unknown): Context {
  const ctx = new Context()
  ctx.provide('dshHomePath', homePath)
  return ctx
}

function runningResolver(home: string, root: string = HOMES): (specifier: string) => string {
  const anchor = join(root, home, 'profiles', 'running-probe.cjs')
  return specifier => pathToFileURL(createRequire(anchor).resolve(specifier)).href
}

const NO_RUNNING = (): string => { throw new Error('no running module tree') }

const ELSEWHERE = join(tmpdir(), 'dsh-context-plugin-root')

const fixedUrl = (url: string) => (): string => url

let scratch = ''

function writeScratchHome(
  home: string,
  packageName: string,
  manifest: string,
  entry?: { path: string; decoyManifest?: string },
): string {
  const dir = join(scratch, home, 'profiles', 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest)
  if (entry !== undefined) {
    const entryPath = join(dir, entry.path)
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(entryPath, '')
    if (entry.decoyManifest !== undefined) {
      writeFileSync(join(dirname(entryPath), 'package.json'), entry.decoyManifest)
    }
  }
  return join(scratch, home)
}

const scratchResolver = (home: string): (...segments: string[]) => string => resolverIn(join(scratch, home))

function shadow(home: string, packageName: string): void {
  writeScratchHome(home, packageName,
    JSON.stringify({ name: packageName, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-context-version-'))
  shadow('library-only', '@deepseek-ai/dsh')
  writeScratchHome('library-only', '@deepseek-ai/dsh-session-projection',
    JSON.stringify({ name: '@deepseek-ai/dsh-session-projection', version: '0.1.1-rc.2' }))
  writeScratchHome('entry-only', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('entry-nested', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.4', exports: { '.': './a/b/index.js' } }),
    { path: 'a/b/index.js', decoyManifest: JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9' }) })
  writeScratchHome('entry-badjson', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.5', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'not json{' })
  writeScratchHome('entry-null', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.6', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'null' })
  writeScratchHome('entry-primitive', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.7', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: '"oops"' })
  writeScratchHome('entry-gone', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.8', exports: { '.': './lib/gone.js' } }))
  shadow('entry-gone', '@deepseek-ai/dsh-session-projection')
  shadow('entry-gone', '@deepseek-ai/dsh-session')
  writeScratchHome('entry-orphan', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-orphan', version: '1.0.0', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('entry-orphan', '@deepseek-ai/dsh')
  shadow('entry-orphan', '@deepseek-ai/dsh-session-projection')
  writeScratchHome('nonstring-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: 42, exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('nonstring-version', '@deepseek-ai/dsh-session-projection')
  shadow('nonstring-version', '@deepseek-ai/dsh-session')
  writeScratchHome('empty-version', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('empty-version', '@deepseek-ai/dsh-session-projection')
  shadow('empty-version', '@deepseek-ai/dsh-session')
  mkdirSync(join(scratch, 'empty', 'profiles'), { recursive: true })
  shadow('empty', '@deepseek-ai/dsh')
  shadow('empty', '@deepseek-ai/dsh-session-projection')
  shadow('empty', '@deepseek-ai/dsh-session')
  writeScratchHome('running-supported', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.2.0-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-old', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.7-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-decoy', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  shadow('running-decoy', '@deepseek-ai/dsh-session-projection')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectHarnessVersion — running anchor', () => {
  test('outranks a stale home mirror, even when the running tree is below the baseline', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('old')), runningResolver('running-supported', scratch), ELSEWHERE), '0.2.0-rc.2')
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('future')), runningResolver('running-old', scratch), ELSEWHERE), '0.1.7-rc.2')
  })

  test('discards a witness inside this package own closure and never probes the CLI package for the home anchor', () => {
    const ctx = ctxWithHome(homeResolver('old'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli')), '0.1.7-rc.2')
    const empty = ctxWithHome(scratchResolver('empty'))
    assert.equal(detectHarnessVersion(empty, runningResolver('module-skips-cli'), ELSEWHERE), '0.2.0-rc.2')
  })

  test('an unusable running witness falls through to the home anchor', () => {
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('running-decoy', scratch), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl('data:text/javascript,'), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), ELSEWHERE), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), join(ELSEWHERE, 'inner')), '0.3.0-rc.1')
  })
})

describe('detectHarnessVersion — home anchor', () => {
  test('reads the CLI package manifest of the running installation', () => {
    const ctx = (home: string) => ctxWithHome(homeResolver(home))
    assert.equal(detectHarnessVersion(ctx('old'), NO_RUNNING), '0.1.7-rc.2')
    assert.equal(detectHarnessVersion(ctx('baseline'), NO_RUNNING), '0.2.0-rc.2')
    assert.equal(detectHarnessVersion(ctx('future'), NO_RUNNING), '0.3.0-rc.1')
    assert.equal(detectHarnessVersion(ctx('dev'), NO_RUNNING), '0.0.0-dev')
  })

  test('falls through to the library packages when the CLI row is absent', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('library-only')), NO_RUNNING), '0.1.1-rc.2')
  })

  test('ascends from the entry point, skipping mismatched, invalid, null, and primitive manifests', () => {
    const cases: [string, string | undefined][] = [
      ['entry-only', '0.1.1-rc.1'],
      ['entry-nested', '0.1.1-rc.4'],
      ['entry-badjson', '0.1.1-rc.5'],
      ['entry-null', '0.1.1-rc.6'],
      ['entry-primitive', '0.1.1-rc.7'],
      ['entry-gone', undefined],
    ]
    for (const [home, expected] of cases) {
      assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver(home)), NO_RUNNING), expected, home)
    }
  })
})

describe('detectHarnessVersion — degradation arms (fail open)', () => {
  test('an absent, non-function, or hostile home probe yields undefined', () => {
    assert.equal(detectHarnessVersion(new Context(), NO_RUNNING), undefined)
    assert.equal(detectHarnessVersion(ctxWithHome(42), NO_RUNNING), undefined)
    const throwing = ctxWithHome(() => { throw new Error('hostile home') })
    assert.equal(detectHarnessVersion(throwing, NO_RUNNING), undefined)
    const hostile = { get() { throw new Error('hostile ctx') } } as unknown as Context
    assert.equal(detectHarnessVersion(hostile, NO_RUNNING), undefined)
  })

  test('the default running anchor discards this package own devDependencies', () => {
    assert.equal(detectHarnessVersion(new Context()), undefined)
  })

  test('a resolving package whose manifest never matches → undefined', () => {
    const ctx = ctxWithHome(scratchResolver('entry-orphan'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('unreadable/invalid/odd manifests all degrade to undefined', () => {
    for (const home of ['nonstring-version', 'empty-version', 'empty']) {
      const ctx = ctxWithHome(scratchResolver(home))
      assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined, home)
    }
  })
})
