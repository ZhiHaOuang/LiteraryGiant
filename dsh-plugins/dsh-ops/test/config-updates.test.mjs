/** One-time per-row update self-check and owning-row persistence through the profile config editor.
 *
 * Regression guard for #91/#108: the marker must reach the profile *patch* layer
 * via `configEditor.edit()`, never `EntryTree.write()`. That whole-tree
 * write-back bakes the composed rows into the profile root file, which made the
 * `ui-theme` settings row echo its previous `preference`/`fontSize` and bounce.
 */
import { updatedConfig, mountConfigUpdates, CONFIG_UPDATE_VERSION } from '../lib/config-updates.js'
import { LEGACY_FASTCTX_KEYS, resolveConfig } from '../lib/config.js'
import { assert, report, test, tick, waitFor } from './lib/harness.mjs'

/**
 * Build a fixture row plus the two persistence surfaces the code may reach.
 * `tree.write` is a tripwire: the suite fails loudly if anything calls it.
 */
function fixture(config, { name = 'dsh-ops/shell', failEdit = false, noEditor = false, noEntry = false, logger = null, authoritative = null, mutateThenThrow = false, failWith = null } = {}) {
  const edits = [], updates = [], logs = [], infos = [], warns = [], cleanup = [], treeWrites = []
  let editCalls = 0
  const entry = { options: { name, config },
    parent: { tree: { write() { treeWrites.push(true); throw new Error('EntryTree.write() must not be used (#91/#108)') } } },
    async update({ config: next }) { entry.options.config = next; updates.push(next) } }
  // Stand-in for @deepseek-ai/dsh-config-editor: hand the candidate back to the row
  // exactly like the service's loader reconciliation does.
  const editor = { async edit(target, change) {
    editCalls += 1
    if (failWith) throw failWith.value
    if (mutateThenThrow) {
      // The real editor reconciles the row before it rethrows; whatever it leaves
      // behind must not make the migration look saved.
      target.options.config = { ...(target.options.config ?? {}), extraGuidance: 'reconciled before failure' }
      throw new Error('write failed after reconcile')
    }
    if (failEdit) throw new Error('read-only profile')
    // `edit()` re-reads the row under the profile lock and hands *that* value to the
    // callback. `authoritative` lets a test make it differ from the row as the
    // scheduler saw it — the window these cases exist to pin.
    const current = structuredClone(authoritative ?? target.options.config ?? {})
    const next = change(current, {})
    target.options.config = next
    edits.push(structuredClone(next))
  } }
  // Severity is kept apart from the combined transcript: #136's discipline is that the in-memory
  // degradation is information, while only a refused save is worth a warning.
  const stream = logger ?? {
    info: message => { logs.push(message); infos.push(message) },
    warn: message => { logs.push(message); warns.push(message) },
  }
  const ctx = { fiber: noEntry ? {} : { entry }, logger: stream,
    effect(body) { cleanup.push(body()) },
    get: key => (noEditor ? undefined : key === 'configEditor' ? editor : undefined) }
  return { entry, ctx, edits, updates, logs, infos, warns, cleanup, treeWrites, get editCalls() { return editCalls } }
}

await test('first run disables explicit true, marks completion, and preserves unrelated raw config', () => {
  const raw = { allowSystemShellFallback: true, bashPath: 'operator-choice', extraGuidance: 'keep', promptPolicy: { __jsExpr: 'true' } }
  const next = updatedConfig(raw)
  assert.equal(next.allowSystemShellFallback, false)
  assert.equal(next.configUpdateVersion, CONFIG_UPDATE_VERSION)
  assert.equal(next.promptPolicy, raw.promptPolicy)
  assert.equal(next.bashPath, raw.bashPath)
  assert.equal(raw.allowSystemShellFallback, true, 'never mutate input')
})
await test('evaluated true expressions are replaced but unrelated raw expressions survive persistence', async () => {
  const expression = { __jsExpr: 'true' }
  const other = { __jsExpr: 'true' }
  const f = fixture({ allowSystemShellFallback: expression, promptPolicy: other })
  mountConfigUpdates(f.ctx, { allowSystemShellFallback: true })
  await tick(); await tick()
  assert.equal(f.edits.length, 1)
  assert.equal(f.edits[0].allowSystemShellFallback, false)
  assert.deepEqual(f.edits[0].promptPolicy, other)
  assert.equal(f.edits[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
  assert.equal(f.entry.options.config.allowSystemShellFallback, false)
  // Structural, not referential: the editor re-reads the row (so it hands the callback, and
  // writes back, a fresh object). Asserting reference identity here only ever described the
  // fixture, which is the false confidence the #138 review called out.
  assert.deepEqual(f.entry.options.config.promptPolicy, other)
})

await test('self-check records first run even when fallback is absent or already false', () => {
  for (const raw of [{}, { allowSystemShellFallback: false }]) {
    const next = updatedConfig(raw)
    assert.equal(next.configUpdateVersion, CONFIG_UPDATE_VERSION)
    assert.equal(next.allowSystemShellFallback, raw.allowSystemShellFallback)
  }
})
await test('subsequent manual true and future version markers are not overwritten', () => {
  for (const configUpdateVersion of [CONFIG_UPDATE_VERSION, CONFIG_UPDATE_VERSION + 1]) {
    const raw = { configUpdateVersion, allowSystemShellFallback: true }
    assert.equal(updatedConfig(raw), raw)
    assert.equal(resolveConfig(updatedConfig(raw)).allowSystemShellFallback, true)
  }
  // A row already past step 1 keeps a later manual opt-in: step 1 never re-runs.
  const afterStepOne = updatedConfig({ configUpdateVersion: 1, allowSystemShellFallback: true }, true)
  assert.equal(afterStepOne.allowSystemShellFallback, true)
  assert.equal(afterStepOne.configUpdateVersion, CONFIG_UPDATE_VERSION)
  for (const value of [-1, '1', 1.5, true]) assert.throws(() => resolveConfig({ configUpdateVersion: value }), /configUpdateVersion/)
})
await test('update 2 drops the removed FastCtx keys from rows at version 0 and 1, and nothing else', () => {
  assert.equal(CONFIG_UPDATE_VERSION, 2)
  const legacy = { serverName: 'fastctx', enableShellTools: false, toolCallTimeoutMs: 300000 }
  for (const configUpdateVersion of [undefined, 0, 1]) {
    const raw = { ...(configUpdateVersion === undefined ? {} : { configUpdateVersion }), ...legacy, promptPolicy: true, required: false, binaryPath: 'C:\\w.exe' }
    const next = updatedConfig(raw)
    for (const key of LEGACY_FASTCTX_KEYS) assert.equal(Object.hasOwn(next, key), false, `${key} removed from version ${configUpdateVersion}`)
    assert.deepEqual({ promptPolicy: next.promptPolicy, required: next.required, binaryPath: next.binaryPath }, { promptPolicy: true, required: false, binaryPath: 'C:\\w.exe' })
    assert.equal(next.configUpdateVersion, 2)
    assert.equal(raw.serverName, 'fastctx', 'never mutate input')
  }
})
await test('an unmigrated row carrying the legacy keys still validates, and they are never returned', () => {
  // Exactly what the bundle patch wrote into every existing file row.
  const fileRow = { promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000 }
  const config = resolveConfig(fileRow)
  for (const key of LEGACY_FASTCTX_KEYS) assert.equal(Object.hasOwn(config, key), false)
  assert.equal(config.promptPolicy, true)
  assert.doesNotThrow(() => resolveConfig({ serverName: 'ops-tools' }))
  // Malformed legacy values still fail loud, as before.
  assert.throws(() => resolveConfig({ serverName: 'bad name!' }), /serverName/)
  assert.throws(() => resolveConfig({ enableShellTools: 'yes' }), /enableShellTools/)
  assert.throws(() => resolveConfig({ toolCallTimeoutMs: -1 }), /toolCallTimeoutMs/)
})
await test('a version-1 file row is persisted once with the legacy keys removed', async () => {
  const f = fixture({ configUpdateVersion: 1, promptPolicy: true, enableShellTools: false, required: false, toolCallTimeoutMs: 300000 }, { name: 'dsh-ops/file' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.equal(f.edits.length, 1)
  assert.deepEqual(f.edits[0], { configUpdateVersion: 2, promptPolicy: true, required: false })
})
await test('persistence is deferred, once only, and survives a recreated context', async () => {
  const f = fixture({ allowSystemShellFallback: true, extraGuidance: 'keep' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  mountConfigUpdates(f.ctx, f.entry.options.config)
  assert.equal(f.edits.length, 0)
  await tick(); await tick()
  assert.equal(f.edits.length, 1)
  assert.equal(f.entry.options.config.allowSystemShellFallback, false)
  assert.equal(f.entry.options.config.extraGuidance, 'keep')
  f.entry.options.config.allowSystemShellFallback = true
  const restart = fixture(JSON.parse(JSON.stringify(f.entry.options.config)))
  mountConfigUpdates(restart.ctx, restart.entry.options.config)
  await tick()
  assert.equal(restart.edits.length, 0)
  assert.equal(restart.entry.options.config.allowSystemShellFallback, true)
})
await test('no foreign row is touched, and disposal cancels pending persistence', async () => {
  const foreign = fixture({ allowSystemShellFallback: true }, { name: 'other-plugin' })
  mountConfigUpdates(foreign.ctx, foreign.entry.options.config)
  await tick()
  assert.equal(foreign.edits.length, 0)
  const own = fixture({ allowSystemShellFallback: true })
  mountConfigUpdates(own.ctx, own.entry.options.config)
  for (const dispose of own.cleanup) dispose()
  await tick()
  assert.equal(own.edits.length, 0)
})
await test('persistence failure does not retain a completion marker and warns without dumping config', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { failEdit: true })
  const original = f.entry.options.config
  mountConfigUpdates(f.ctx, original)
  await tick(); await tick()
  assert.equal(f.entry.options.config, original)
  assert.equal(f.entry.options.config.configUpdateVersion, undefined)
  assert.ok(f.logs.some(message => message.includes('could not be saved')))
  assert.equal(f.logs.some(message => message.includes('extraGuidance')), false)
})
await test('a profile without the config editor stays in memory and never touches the loader tree', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { noEditor: true })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.equal(f.edits.length, 0)
  assert.equal(f.treeWrites.length, 0)
  assert.equal(f.entry.options.config.allowSystemShellFallback, true, 'in-memory migration must not rewrite the raw row')
  assert.ok(f.logs.some(message => message.includes('applied in memory only')))
})
await test('the owning loader tree is never written, even when it is available (#91/#108)', async () => {
  const f = fixture({ allowSystemShellFallback: true, extraGuidance: 'keep' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.equal(f.treeWrites.length, 0)
  assert.equal(f.edits.length, 1)
  assert.ok(f.logs.every(message => !message.includes('owning loader for persistence')))
})
await test('each component owns its marker, and concurrent config edits are preserved', async () => {
  for (const name of ['dsh-ops', 'dsh-ops/shell', 'dsh-ops/file']) {
    const f = fixture({ allowSystemShellFallback: true }, { name })
    mountConfigUpdates(f.ctx, f.entry.options.config)
    f.entry.options.config = { allowSystemShellFallback: false, extraGuidance: 'new edit' }
    await tick(); await tick()
    assert.equal(f.edits.length, 1)
    assert.equal(f.edits[0].extraGuidance, 'new edit')
    assert.equal(f.edits[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
  }
  // The removed background row is a no-op stub; its saved config is never rewritten.
  const background = fixture({ enableShellTools: true }, { name: 'dsh-ops/background' })
  mountConfigUpdates(background.ctx, background.entry.options.config)
  await tick(); await tick()
  assert.equal(background.edits.length, 0)
})
await test('real component mount migrates before publication and preserves manual opt-in after restart', async () => {
  const { bootHost, shutdown, scopedToolNames } = await import('./lib/host.mjs')
  const { applyComponent } = await import('../lib/index.js')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { ctx } = await bootHost()
  const snapshots = [], effective = []
  let fiber
  const entry = { options: { name: 'dsh-ops/shell', config: { allowSystemShellFallback: true, bashPath: process.execPath } },
    parent: { tree: { write() { throw new Error('EntryTree.write() must not be used (#91/#108)') } } },
    async update({ config }) { entry.options.config = config; fiber.update(config, true) } }
  try {
    await ctx.plugin(inner => {
      inner.provide('subprocess', { spawn() { throw new Error('not executed') } })
      inner.provide('sandboxPolicy', { resolve() { return { mode: 'danger-full-access' } } })
      // Stand-in for @deepseek-ai/dsh-config-editor: apply the candidate to the row
      // exactly like the real service does, so the mount path is exercised end to end.
      inner.provide('configEditor', { async edit(target, change) {
        const next = change(structuredClone(target.options.config ?? {}), {})
        target.options.config = next
        snapshots.push({ ...next })
      } })
    })
    fiber = await ctx.plugin({ name: 'fixture-update-owner', apply(inner, raw) {
      inner.fiber.entry = entry
      effective.push(resolveConfig(updatedConfig(raw)).allowSystemShellFallback)
      applyComponent(inner, raw, 'shell')
    } }, entry.options.config)
    await waitFor(() => snapshots.length === 1 && effective.length >= 1, { timeoutMs: 5000 })
    assert.deepEqual(effective, [false])
    assert.equal(snapshots[0].allowSystemShellFallback, false)
    assert.equal(snapshots[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
    // The component remains mounted and scoped tools remain available after
    // migration; the fix removes the redundant remount, not the mount itself.
    const agent = { id: 'migrated-agent', session: { header: { cwd: process.cwd() } } }
    await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    await waitFor(() => scopedToolNames(ctx, agent).includes('ops_bash'), { timeoutMs: 5000 })
    // A later ordinary profile edit still follows the host's normal update path.
    await entry.update({ config: { ...entry.options.config, allowSystemShellFallback: true } })
    await waitFor(() => effective.length === 2, { timeoutMs: 5000 })
    assert.equal(effective.at(-1), true)
    assert.equal(resolveConfig(fiber.config).allowSystemShellFallback, true)
    // Migration itself does not trigger a second mount or another persisted edit.
    assert.equal(snapshots.length, 1)
  } finally { await shutdown(ctx) }
})
await test('an unavailable editor is noted once per logger, not once per activation (#136)', async () => {
  // Two rows of the same process share one logger, which is what makes the deduplication
  // observable: the second activation may not repeat the first one's line.
  const logs = []
  const logger = { info: message => logs.push(message), warn: message => logs.push(message) }
  const first = fixture({ allowSystemShellFallback: true }, { noEditor: true, logger })
  const second = fixture({ allowSystemShellFallback: true }, { noEditor: true, logger })
  mountConfigUpdates(first.ctx, first.entry.options.config)
  mountConfigUpdates(second.ctx, second.entry.options.config)
  await tick(); await tick()
  assert.equal(logs.filter(message => message.includes('applied in memory only')).length, 1)
  assert.deepEqual([...first.edits, ...second.edits], [])
  assert.deepEqual([...first.treeWrites, ...second.treeWrites], [])
  assert.equal(first.entry.options.config.allowSystemShellFallback, true)
  assert.equal(second.entry.options.config.allowSystemShellFallback, true)
})
await test('a context with no owning row migrates in memory and is not an error (#136)', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { noEntry: true })
  mountConfigUpdates(f.ctx, { allowSystemShellFallback: true })
  await tick(); await tick()
  assert.deepEqual(f.edits, [])
  assert.deepEqual(f.treeWrites, [])
  assert.equal(f.infos.filter(message => message.includes('applied in memory only')).length, 1)
  assert.equal(f.warns.length, 0, 'a missing owning row is information, not a warning')
  assert.equal(f.logs.some(message => message.includes('no owning loader row')), true)
})
await test('the candidate comes from the editor\'s authoritative current, not the scheduled snapshot', async () => {
  // The row changes between scheduling and the write. `edit()` re-reads it and hands
  // that value to the callback, so a candidate captured earlier would drop the edit.
  const f = fixture({ allowSystemShellFallback: true },
    { authoritative: { allowSystemShellFallback: true, extraGuidance: 'concurrent edit' } })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.equal(f.edits.length, 1)
  assert.equal(f.edits[0].extraGuidance, 'concurrent edit', 'a concurrent edit must survive the marker write')
  assert.equal(f.edits[0].allowSystemShellFallback, false)
  assert.equal(f.edits[0].configUpdateVersion, CONFIG_UPDATE_VERSION)
  assert.deepEqual(f.treeWrites, [])
})
await test('a save that fails after the editor reconciled the row is retried, never remembered', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { mutateThenThrow: true })
  const raw = f.entry.options.config
  mountConfigUpdates(f.ctx, raw)
  await tick(); await tick()
  assert.equal(f.editCalls, 1)
  assert.deepEqual(f.edits, [])
  assert.equal(f.entry.options.config.configUpdateVersion, undefined, 'a failed save must not leave a success marker behind')
  assert.ok(f.logs.some(message => message.includes('could not be saved')))
  // Nothing in this plugin remembers the attempt, so the next activation retries.
  mountConfigUpdates(f.ctx, raw)
  await tick(); await tick()
  assert.equal(f.editCalls, 2)
})
await test('a save failure that is not an Error is reported, not thrown back', async () => {
  // `error.message` on `undefined`/`null` would raise from inside the handler that promises to
  // report the failure, turning a failed save into an unhandled rejection.
  for (const value of [undefined, 'a bare string']) {
    const f = fixture({ allowSystemShellFallback: true }, { failWith: { value } })
    mountConfigUpdates(f.ctx, f.entry.options.config)
    await tick(); await tick()
    assert.equal(f.warns.length, 1)
    assert.match(f.warns[0], /could not be saved: /)
    assert.deepEqual(f.edits, [])
  }
})
await test('a logger that cannot key a WeakSet is skipped instead of breaking the notice', async () => {
  const f = fixture({ allowSystemShellFallback: true }, { noEditor: true, logger: 'not-a-logger' })
  mountConfigUpdates(f.ctx, f.entry.options.config)
  await tick(); await tick()
  assert.deepEqual(f.infos, [])
  assert.deepEqual(f.edits, [])
  assert.deepEqual(f.treeWrites, [])
})
report('config-updates')
