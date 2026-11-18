/** Session cache references remain data handles, never authority or nested output wrappers. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareWorkspace } from '../lib/workspace-preparation.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, callWorker, request, envelopeOf, requireWorker, WORKER } from './lib/boundary.mjs'
requireWorker('result-references')
const authorityId = 'a'.repeat(64)
const scope = 'session / 測試'
const directory = cache => path.join(cache, `s-${createHash('sha256').update(scope).digest('hex')}`)
const input = (root, cache, args, options = {}) => ({ version: 1, requestId: 'reference-test', component: 'ptc', budget: { timeoutMs: 30000, maxBytes: 131072 },
  storage: { root: cache, authorityId, allowedTools: ['result', 'batch'] }, request: request('result', args, { root, scope, ...options }) })
const send = async value => envelopeOf(await callWorker(JSON.stringify(value)), assert)
const call = (root, cache, args, options) => send(input(root, cache, args, options))
const fixture = body => withTempDir('refs', async root => { const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 }); await body(root, cache) })
const blob = (cache, handle) => path.join(directory(cache), `${handle.id.split('/').at(-1)}.json`)
const snapshot = root => fs.readdirSync(root, { recursive: true }).sort()

await test('handles expose physical snapshot metadata, session lifetime, and lossless bounded pages', async () => {
  await fixture(async (root, cache) => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ index, text: `row ${index} \0 中`, kind: index % 2 }))
    const stored = await call(root, cache, { action: 'put', items: rows })
    assert.equal(stored.status, 'completed', JSON.stringify(stored))
    assert.match(stored.id, /^ref:\/\/session%20%2F%20%E6%B8%AC%E8%A9%A6\/result\/[a-f0-9-]{36}$/)
    assert.equal(stored.reference.refId, stored.id); assert.equal(stored.reference.ttlMs, 0)
    assert.equal(stored.reference.producerTool, 'result'); assert.equal(stored.reference.schemaVersion, '1')
    assert.equal(stored.reference.totalItems, 200); assert.equal(stored.reference.totalBytes, fs.statSync(blob(cache, stored)).size)
    assert.ok(stored.reference.createdAt > 1e12); assert.ok(stored.reference.preview.split('\n').length <= 10)
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
    const collected = []; let offset = 0
    do {
      const raw = await callWorker(JSON.stringify(input(root, cache, { action: 'page', id: stored.id, offset, limit: 17, maxBytes: 4096 })))
      const page = envelopeOf(raw, assert); assert.ok(Buffer.byteLength(raw.stdout) <= 4096)
      assert.equal(page.reference.totalBytes, stored.reference.totalBytes)
      collected.push(...page.items); assert.equal(page.nextOffset, offset + page.items.length); offset = page.nextOffset
      if (page.complete) break
      assert.ok(page.items.length > 0)
    } while (offset < rows.length)
    assert.deepEqual(collected, rows)
    const filtered = await call(root, cache, { action: 'page', id: stored.id, equals: { kind: 1 }, fields: ['index'], limit: 512 })
    assert.equal(filtered.total, 100); assert.equal(filtered.sourceTotal, 200)
    assert.deepEqual(filtered.items[1], { index: 3 }); assert.equal(filtered.complete, true)
  })
})

await test('references recheck session, root, authority, capability and credentials on every access', async () => {
  await fixture(async (root, cache) => {
    const stored = await call(root, cache, { action: 'put', items: [{ text: 'private snapshot' }] })
    const other = path.join(root, 'other'); fs.mkdirSync(other)
    for (const mutate of [
      value => { value.request.scope = 'foreign' },
      value => { value.request.root = other },
      value => { value.storage.authorityId = 'b'.repeat(64) },
      value => { value.storage.allowedTools = [] },
      value => { value.request.args.id = stored.id.replace('/result/', '/batch/') },
      value => { value.request.deny_roots = [cache] },
    ]) {
      const value = input(root, cache, { action: 'page', id: stored.id }); mutate(value)
      const denied = await send(value)
      assert.ok(['POLICY_DENIED', 'CREDENTIAL_DENIED'].includes(denied.error?.code), JSON.stringify(denied))
      assert.equal(denied.error.effectState, 'none'); assert.equal(denied.items, undefined)
    }
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).items[0].text, 'private snapshot')
  })
})

await test('trusted cache authorization is independent of unchanged business write roots', async () => {
  await fixture(async (root, cache) => {
    const business = path.join(root, 'workspace'); fs.mkdirSync(business)
    const stored = await call(business, cache, { action: 'put', items: [{ private: true }] }, { writeRoots: [business] })
    assert.equal(stored.status, 'completed', JSON.stringify(stored))
    assert.deepEqual((await call(business, cache, { action: 'page', id: stored.id }, { writeRoots: [business] })).items, [{ private: true }])
    const outside = path.join(cache, 'not-a-cache-object')
    const write = input(business, cache, { path: outside, content: 'forbidden', expectedRevision: 'absent' }, { writeRoots: [business] })
    write.request.tool = 'write_file'
    const denied = await send(write)
    assert.equal(denied.error.code, 'POLICY_DENIED'); assert.equal(denied.error.effectState, 'none')
    assert.equal(fs.existsSync(outside), false)
    assert.equal((await call(business, cache, { action: 'purge' }, { writeRoots: [business] })).removed, 1)
  })
})

await test('read-only pages do not touch LRU or create storage and cannot put or release', async () => {
  await fixture(async (root, cache) => {
    const stored = await call(root, cache, { action: 'put', items: [{ value: 1 }] })
    const filename = blob(cache, stored); const beforeTime = fs.statSync(filename).mtimeMs; const before = snapshot(root)
    const page = await call(root, cache, { action: 'page', id: stored.id }, { readOnly: true })
    assert.equal(page.complete, true); assert.equal(fs.statSync(filename).mtimeMs, beforeTime)
    assert.deepEqual(snapshot(root), before)
    for (const args of [{ action: 'put', items: [] }, { action: 'release', id: stored.id }]) {
      const denied = await call(root, cache, args, { readOnly: true })
      assert.equal(denied.error.code, 'POLICY_DENIED'); assert.equal(denied.error.effectState, 'none')
    }
    const other = path.join(root, 'empty-cache'); fs.mkdirSync(other)
    const missing = await call(root, other, { action: 'page', id: stored.id }, { readOnly: true })
    assert.equal(missing.error.code, 'REFERENCE_EXPIRED'); assert.deepEqual(fs.readdirSync(other), [])
    assert.equal((await call(root, other, { action: 'page', id: stored.id })).error.code, 'REFERENCE_EXPIRED')
    assert.deepEqual(fs.readdirSync(other), [])
  })
})

await test('trusted metadata cannot be injected through args, legacy requests or partial envelopes', async () => {
  await fixture(async (root, cache) => {
    const cases = []
    const valid = input(root, cache, { action: 'put', items: [] })
    cases.push({ ...valid, storage: { ...valid.storage, authorityId: 'invalid' } })
    cases.push({ ...valid, storage: { ...valid.storage, allowedTools: ['../result'] } })
    for (const sid of ['S-1-1-0', 'S-1-5-5-1-2', 'S-1-4-1-2', 'S-1-4-0-1-1', 'S-1-4-01-2-1', 'S-1-4-1073741824-1-1']) {
      cases.push({ ...valid, storage: { ...valid.storage, windowsWriteSid: sid } })
    }
    cases.push({ ...valid, request: { ...valid.request, storage: valid.storage } })
    cases.push({ ...valid, request: { ...valid.request, args: { ...valid.request.args, storage: valid.storage } } })
    cases.push({ ...valid.request, storage: valid.storage })
    for (const value of cases) { const denied = await send(value); assert.equal(denied.error.code, 'INVALID_ARGUMENT', JSON.stringify(denied)); assert.equal(denied.error.effectState, 'none') }
    const noStorage = input(root, cache, { action: 'purge' }); delete noStorage.storage
    assert.equal((await send(noStorage)).error.code, 'POLICY_DENIED')
    assert.deepEqual(fs.readdirSync(cache), [])
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
  })
})

await test('nested handles are refused and oversized reference pages never produce another handle', async () => {
  await fixture(async (root, cache) => {
    const stored = await call(root, cache, { action: 'put', items: [{ large: 'x'.repeat(10000), small: 1 }] })
    for (const nested of [stored.reference, { deep: [stored.reference] }]) {
      const denied = await call(root, cache, { action: 'put', items: [nested] })
      assert.equal(denied.error.code, 'INVALID_ARGUMENT')
    }
    const before = snapshot(cache)
    const limited = await call(root, cache, { action: 'page', id: stored.id, maxBytes: 2048 })
    assert.equal(limited.error.code, 'OUTPUT_LIMIT'); assert.equal(limited.reference, undefined)
    assert.deepEqual(snapshot(cache), before)
    const projected = await call(root, cache, { action: 'page', id: stored.id, fields: ['small'], maxBytes: 2048 })
    assert.deepEqual(projected.items, [{ small: 1 }]); assert.equal(projected.complete, true)
    const text = await call(root, cache, { action: 'put', items: [{ text: stored.id }] })
    assert.equal(text.status, 'completed', 'literal text is not a nested StorageReference')
  })
})

await test('TTL expiry and release return expired references while retaining session ownership checks', async () => {
  await fixture(async (root, cache) => {
    const stored = await call(root, cache, { action: 'put', items: [{ value: 1 }], ttlMs: 1 })
    const expired = await call(root, cache, { action: 'page', id: stored.id })
    assert.equal(expired.error.code, 'REFERENCE_EXPIRED')
    const foreign = input(root, cache, { action: 'release', id: stored.id }); foreign.request.scope = 'other'
    assert.equal((await send(foreign)).error.code, 'POLICY_DENIED')
    assert.equal((await call(root, cache, { action: 'release', id: stored.id })).status, 'released')
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).error.code, 'REFERENCE_EXPIRED')
    const tooLong = await call(root, cache, { action: 'put', items: [], ttlMs: 604800001 })
    assert.equal(tooLong.error.code, 'INVALID_ARGUMENT')
  })
})

await test('no-follow protects cache parents, session directories, locks and stored snapshots', async () => {
  await fixture(async (root, cache) => {
    const stored = await call(root, cache, { action: 'put', items: [{ value: 1 }] })
    const alias = path.join(root, 'alias'); fs.symlinkSync(cache, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await call(root, alias, { action: 'page', id: stored.id })).error.code, 'PATH_RESTRICTED')
    const session = directory(cache); const real = `${session}-real`; fs.renameSync(session, real)
    fs.symlinkSync(real, session, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).error.code, 'PATH_RESTRICTED')
    assert.equal(fs.lstatSync(session).isSymbolicLink(), true); fs.unlinkSync(session); fs.renameSync(real, session)
    const snapshotPath = blob(cache, stored); fs.linkSync(snapshotPath, `${snapshotPath}.alias`)
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).error.code, 'PATH_RESTRICTED')
    fs.unlinkSync(`${snapshotPath}.alias`)
    const lock = path.join(session, 'lock'); fs.linkSync(lock, `${lock}.alias`)
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).error.code, 'PATH_RESTRICTED')
    fs.unlinkSync(`${lock}.alias`)
    assert.equal((await call(root, cache, { action: 'page', id: stored.id })).complete, true)
  })
})

await test('new operation references feed existing batch authority and leave durable audit records separate', async () => {
  await fixture(async (root, cache) => {
    fs.writeFileSync(path.join(root, 'source'), 'content')
    const stored = await call(root, cache, { action: 'put', items: [{ op: 'copy', path: 'source', to: 'destination' }] })
    const value = input(root, cache, { action: 'plan', operationsRef: stored.id }); value.request.tool = 'batch'
    const plan = await send(value)
    assert.match(plan.id, /^j-/); assert.equal(fs.existsSync(path.join(root, 'destination')), false)
    const audit = path.join(root, '.dsh-ops'); const before = Object.fromEntries(fs.readdirSync(audit).map(name => [name, fs.readFileSync(path.join(audit, name)).toString('hex')]))
    assert.equal((await call(root, cache, { action: 'release', id: stored.id })).status, 'released')
    const after = Object.fromEntries(fs.readdirSync(audit).map(name => [name, fs.readFileSync(path.join(audit, name)).toString('hex')]))
    assert.deepEqual(after, before)
    const page = envelopeOf(await callTool('result', { action: 'page', id: plan.id }, { root, scope }), assert)
    assert.equal(page.items[0].state, 'pending')
  })
})

await test('cross-process writers serialize quota decisions and never evict audit records', async () => {
  await fixture(async (root, cache) => {
    fs.writeFileSync(path.join(root, 'source'), 'audit source')
    const audit = envelopeOf(await callTool('batch', { action: 'plan', operations: [{ op: 'copy', path: 'source', to: 'dest' }] }, { root, scope }), assert)
    assert.match(audit.id, /^j-/)
    const auditDir = path.join(root, '.dsh-ops')
    const before = Object.fromEntries(fs.readdirSync(auditDir).map(name => [name, fs.readFileSync(path.join(auditDir, name)).toString('hex')]))
    const payload = 'x'.repeat(1_900_000); const handles = []
    for (let index = 0; index < 57; index++) {
      const value = await call(root, cache, { action: 'put', items: [{ index, payload }] })
      assert.equal(value.status, 'completed', JSON.stringify(value)); handles.push(value)
    }
    assert.equal((await call(root, cache, { action: 'page', id: handles[0].id })).error.code, 'REFERENCE_EXPIRED')
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) => call(root, cache, { action: 'put', items: [{ concurrent: index, payload }] })))
    assert.ok(values.some(value => value.status === 'completed'))
    for (const value of values) assert.ok(value.status === 'completed' || value.error?.code === 'JOB_BUSY', JSON.stringify(value))
    const session = directory(cache)
    const size = fs.readdirSync(session).reduce((sum, name) => sum + fs.statSync(path.join(session, name)).size, 0)
    assert.ok(size <= 100 * 1024 * 1024, String(size))
    const after = Object.fromEntries(fs.readdirSync(auditDir).map(name => [name, fs.readFileSync(path.join(auditDir, name)).toString('hex')]))
    assert.deepEqual(after, before)
    assert.equal(fs.existsSync(path.join(root, 'dest')), false)
  })
})
await test('session purge removes only validated snapshots and stages, preserving lock and audit namespaces', async () => {
  await fixture(async (root, cache) => {
    const store = () => call(root, cache, { action: 'put', items: [{ value: 1 }] })
    const first = await store(); await store()
    const preserved = await store(); const auditPath = path.join(directory(cache), 'j-audit.json')
    fs.renameSync(blob(cache, preserved), auditPath)
    const auditBytes = fs.readFileSync(auditPath)
    const stage = await store(); fs.renameSync(blob(cache, stage), blob(cache, stage).replace(/\.json$/, '.tmp'))
    const foreign = await call(root, cache, { action: 'put', items: [{ private: 'other' }] }, { scope: 'other' })
    const lockPath = path.join(directory(cache), 'lock'); const inode = fs.statSync(lockPath, { bigint: true }).ino
    const before = snapshot(cache)
    assert.equal((await call(root, cache, { action: 'purge' }, { readOnly: true })).error.code, 'POLICY_DENIED')
    assert.equal((await call(root, cache, { action: 'purge', id: first.id })).error.code, 'INVALID_ARGUMENT')
    assert.deepEqual(snapshot(cache), before)
    const purged = await call(root, cache, { action: 'purge' })
    assert.equal(purged.status, 'completed'); assert.equal(purged.complete, true)
    assert.equal(purged.removed, 3); assert.equal(purged.retained, 2); assert.equal(purged.effectState, 'applied')
    assert.equal(fs.statSync(lockPath, { bigint: true }).ino, inode); assert.deepEqual(fs.readFileSync(auditPath), auditBytes)
    assert.equal((await call(root, cache, { action: 'page', id: first.id })).error.code, 'REFERENCE_EXPIRED')
    assert.equal((await call(root, cache, { action: 'page', id: foreign.id }, { scope: 'other' })).items[0].private, 'other')
    assert.equal((await call(root, cache, { action: 'purge' })).effectState, 'none')
    const absent = path.join(root, 'never-created')
    assert.equal((await call(root, absent, { action: 'purge' })).removed, 0); assert.equal(fs.existsSync(absent), false)
  })
})

if (process.platform === 'win32') await test('real Windows confinement permits the private temp capability but denies read-only and foreign-session writes', async () => {
  await withTempDir('refs-confined', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Sandbox)
      const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'ref-capability-owner' }
      await prepareWorkspace(policy)
      const confine = (argv, changes = {}) => ctx.get('sandbox').confine(argv, { ...policy, ...changes }, new AbortController().signal)
      const confined = await confine([WORKER])
      assert.equal(confined.enforcement, 'partial')
      const cache = confined.argv[confined.argv.indexOf('--temp') + 1]
      const sid = confined.argv[confined.argv.indexOf('--temp-write-sid') + 1]
      assert.match(sid, /^S-1-4-\d+-\d+-1$/)
      const execute = (argv, value) => {
        const result = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify(value), encoding: 'utf8', timeout: 30_000 })
        assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout)
      }
      const value = input(root, cache, { action: 'put', items: [{ private: true }] }, { writeRoots: [root, cache] })
      value.storage.windowsWriteSid = sid
      const stored = execute(confined.argv, value); assert.equal(stored.status, 'completed', JSON.stringify(stored))
      value.request.args = { action: 'page', id: stored.id }
      assert.deepEqual(execute(confined.argv, value).items, [{ private: true }])
      // Trusted fixed-file execution can use the same privately granted storage without changing its executor.
      assert.deepEqual(execute([WORKER], value).items, [{ private: true }])
      const readonly = await confine([WORKER], { mode: 'read-only' }); value.request.read_only = true
      assert.deepEqual(execute(readonly.argv, value).items, [{ private: true }])
      const filename = blob(cache, stored); const original = fs.readFileSync(filename)
      const attempt = [process.execPath, '-e', 'try { require("node:fs").appendFileSync(process.argv[1],"bad"); process.exit(42) } catch(e) { console.log(e.code) }', filename]
      for (const changes of [{ mode: 'read-only' }, { sessionId: 'ref-capability-foreign' }]) {
        const denied = await confine(attempt, changes)
        const result = spawnSync(denied.argv[0], denied.argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /EACCES|EPERM/)
        assert.deepEqual(fs.readFileSync(filename), original)
      }
      // Even a deliberately false worker read-only flag cannot bypass the OS token's denial.
      value.request.read_only = false; value.request.args = { action: 'put', items: [{ forbidden: true }] }
      assert.equal(execute(readonly.argv, value).error.code, 'ACCESS_DENIED')
      value.storage.windowsWriteSid = 'S-1-4-1-2-1'
      assert.ok(execute(confined.argv, value).error, 'a valid-shaped but ungranted SID cannot authorize cache creation')
    } finally { await shutdown(ctx) }
  })
})
report('result-references')
