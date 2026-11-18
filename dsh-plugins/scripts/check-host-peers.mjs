// No model request: exercise linked OPS against the actual host's scope identity.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [host, profile] = process.argv.slice(2).map(value => resolve(value))
assert(host && profile, 'Usage: node scripts/check-host-peers.mjs <DSH source root> <profile directory>')
const url = path => pathToFileURL(path).href
const { Context } = await import(url(host + '/vendor/cordis/lib/index.js'))
const { createRuntimeResolution, loadProfileDirectory, PluginPackages } = await import(url(host + '/packages/boot/app-boot/lib/index.js'))
const installAnchor = host + '/apps/cli/package.json'
const resolution = await createRuntimeResolution({ installAnchor,
  profile: loadProfileDirectory('lg-peer-check', profile, installAnchor) })
const ctx = new Context()
const fiber = ctx.plugin(PluginPackages, { resolution })
await fiber.await()
try {
  const hostScope = resolution.entries.find(entry => entry.name === '@deepseek-ai/dsh-scope')
  const ops = resolution.linkedRoots.find(entry => entry.name === 'dsh-ops')
  assert(hostScope && ops, 'Profile must include a linked OPS and the host scope package')
  const expected = await import(url(hostScope.packageDir + '/lib/index.js'))
  const { loadScopes } = await import(url(ops.realPath + '/lib/adapter/dsh/host.js'))
  const actual = await loadScopes()
  const key = {}, scope = expected.createScope(ctx, key)
  try {
    assert.equal(actual.scopeOf(scope.ctx), key, 'OPS must recognize the host-created agent scope')
    assert.equal(actual.createScope, expected.createScope, 'Scope module must share one runtime instance')
  } finally { await scope.dispose() }
  console.log('PASS: linked OPS recognizes the actual DSH host scope; no model calls.')
} finally { await fiber.dispose() }
