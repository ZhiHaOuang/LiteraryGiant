/** Recovery keeps bounded append queues and carries lost-record facts into the document. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createPanelCollector, foldRecords, parseAppendLog, resolvePanelConfig } from '../lib/panel/collect.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const config = resolvePanelConfig({ capture: true, textLimit: 100000, maxSessionBytes: 65536 })
const env = { DSH_HOME: path.join(tmpdir(), 'panel-recovery-unrelated-home') }
const time = 1700000000000
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const session = (cwd, id) => ({ id, header: { cwd } })
const event = (text, seq) => ({ type: 'user/message', seq, time: time + seq,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const wire = value => JSON.stringify(value) + '\n'
const record = (text, seq) => ({ record: 'event', seq, time: time + seq, type: 'user/message', role: 'user',
  payload: { text, chars: text.length, truncated: false, droppedChars: 0 } })
const directory = cwd => path.join(cwd, '.dsh-ops', 'panel')
const walPath = (cwd, id) => path.join(directory(cwd), id + '.ndjson')
const data = (cwd, id) => JSON.parse(fs.readFileSync(path.join(directory(cwd), id + '.json'), 'utf8'))

function seed(cwd, id, targetBytes = 0) {
  fs.mkdirSync(directory(cwd), { recursive: true })
  let text = wire({ record: 'open', sessionId: id, cwd, at: new Date(time).toISOString() }), count = 0
  do { text += wire(record('prior-' + count + 'x'.repeat(1000), count++)) }
  while (Buffer.byteLength(text) < targetBytes)
  assert.ok(Buffer.byteLength(text) < config.maxSessionBytes, 'the recovery fixture starts below its cap')
  fs.writeFileSync(walPath(cwd, id), text)
  return { text, count }
}

/** Pause the actual initial log read; no timers or filesystem races decide admission order. */
function pausedRead(wal, failure) {
  const entered = deferred(), release = deferred(), writes = []
  let paused = false
  const io = { ...fs.promises, readFile: async (file, ...args) => {
    if (!paused && String(file) === wal) {
      paused = true; entered.resolve(); await release.promise
      if (failure) throw failure
    }
    return fs.promises.readFile(file, ...args)
  } }
  for (const method of ['mkdir', 'appendFile', 'writeFile', 'rename', 'rm']) io[method] = async (...args) => {
    writes.push(method)
    return fs.promises[method](...args)
  }
  return { io, entered: entered.promise, release: release.resolve, writes }
}

function boundedLog(wal) {
  const lines = fs.readFileSync(wal, 'utf8').trimEnd().split('\n')
  const capped = lines.filter(line => JSON.parse(line).record === 'capped')
  assert.equal(capped.length, 1, 'one cap marker follows the retained event prefix')
  assert.equal(lines.at(-1), capped[0], 'no event is appended after the cap marker')
  const eventBytes = Buffer.byteLength(lines.filter(line => JSON.parse(line).record !== 'capped').join('\n') + '\n')
  assert.ok(eventBytes <= config.maxSessionBytes, `header and events exceed the cap: ${eventBytes}`)
  return lines.map(JSON.parse).filter(value => value.record === 'event')
}

await test('parse failures alone degrade capture and usage without changing retained records', () => {
  const message = { ...record('retained exactly', 0), type: 'assistant/message', role: 'assistant',
    usageReported: true, usageBuckets: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const parsed = parseAppendLog(wire(message) + 'null\n[]\n{"record":"event","usage":')
  const document = foldRecords(parsed.records, { malformed: parsed.malformed })
  assert.equal(parsed.malformed, 3)
  assert.equal(document.events.malformed, 3)
  assert.equal(document.metrics.malformed, 3)
  assert.equal(document.verify.degraded, true)
  assert.equal(document.metrics.usageReported, false, 'discarded records cannot establish complete usage')
  assert.equal(document.metrics.usage.grandTotal, 110)
  assert.deepEqual(document.conversation.map(row => row.text), ['retained exactly'])
})

await test('recovery counts existing bytes before admitting a burst queued during the initial read', async () => {
  await withTempDir('panel-recovery-cap', async cwd => {
    const id = 'burst', prior = seed(cwd, id, config.maxSessionBytes - 5000)
    const pause = pausedRead(walPath(cwd, id)), warnings = []
    const collector = createPanelCollector({ config, env, io: pause.io, now: () => time, report: value => warnings.push(value) })
    const captured = session(cwd, id), burst = 2000
    try {
      for (let index = 0; index < burst; index++) collector.observe(captured, event('queued-' + index + 'y'.repeat(1000), prior.count + index))
      await pause.entered
      assert.deepEqual(pause.writes, [], 'the blocked read owns all subsequent writes')
      pause.release()
      await collector.flush()
      const retained = boundedLog(walPath(cwd, id))
      const added = retained.slice(prior.count)
      assert.ok(added.length > 0 && added.length < burst, 'the available prefix is retained before the budget is exhausted')
      assert.deepEqual(added.map(row => row.seq), Array.from({ length: added.length }, (_, index) => prior.count + index))
      const beforeLater = fs.readFileSync(walPath(cwd, id), 'utf8')
      collector.observe(captured, event('after the cap', prior.count + burst))
      await collector.merge(id)
      assert.equal(fs.readFileSync(walPath(cwd, id), 'utf8'), beforeLater, 'a capped recovery never resumes appending')
      const document = data(cwd, id)
      assert.equal(document.limits.truncated, true)
      assert.equal(document.metrics.eventCount, retained.length)
      assert.equal(document.limits.droppedEvents, burst + 1 - added.length)
      assert.equal(document.metrics.eventCount + document.limits.droppedEvents, prior.count + burst + 1)
      assert.deepEqual(warnings, [])
    } finally { pause.release(); await collector.stop() }
  })
})

await test('bytes queued before recovery remain charged to later appends', async () => {
  await withTempDir('panel-recovery-later', async cwd => {
    const id = 'later', prior = seed(cwd, id, config.maxSessionBytes - 9000)
    const pause = pausedRead(walPath(cwd, id))
    const collector = createPanelCollector({ config, env, io: pause.io, now: () => time })
    const captured = session(cwd, id)
    try {
      collector.observe(captured, event('first queued ' + 'a'.repeat(2000), prior.count))
      collector.observe(captured, event('second queued ' + 'b'.repeat(2000), prior.count + 1))
      await pause.entered; pause.release(); await collector.flush()
      const first = fs.readFileSync(walPath(cwd, id), 'utf8')
      const observed = parseAppendLog(first).records.filter(value => value.record === 'event')
      assert.equal(observed.length, prior.count + 2, 'both queued records fit the recovered budget')
      assert.doesNotMatch(first, /"record":"capped"/)
      const room = config.maxSessionBytes - Buffer.byteLength(first)
      assert.ok(room > 0 && room < config.textLimit)
      // Text consumes all remaining bytes; its record envelope necessarily exceeds the budget.
      collector.observe(captured, event('z'.repeat(room), prior.count + 2))
      await collector.merge(id)
      const retained = boundedLog(walPath(cwd, id))
      assert.deepEqual(retained, observed, 'a later record cannot reuse bytes consumed during recovery')
      assert.equal(data(cwd, id).limits.droppedEvents, 1)
    } finally { pause.release(); await collector.stop() }
  })
})

await test('a small recovered log keeps queued and later messages in order and seals normally', async () => {
  await withTempDir('panel-recovery-normal', async cwd => {
    const id = 'normal', prior = seed(cwd, id), pause = pausedRead(walPath(cwd, id))
    const collector = createPanelCollector({ config, env, io: pause.io })
    const captured = session(cwd, id)
    try {
      collector.observe(captured, event('queued one', prior.count))
      collector.observe(captured, event('queued two', prior.count + 1))
      await pause.entered; pause.release(); await collector.flush()
      collector.observe(captured, event('later', prior.count + 2))
      await collector.close(id)
      const document = data(cwd, id)
      assert.deepEqual(document.conversation.map(row => row.text), ['prior-0' + 'x'.repeat(1000), 'queued one', 'queued two', 'later'])
      assert.equal(document.limits.truncated, false)
      assert.equal(document.limits.droppedEvents, 0)
      assert.equal(document.verify.degraded, false)
      assert.equal(fs.existsSync(walPath(cwd, id)), false, 'explicit sealing removes the append log')
      assert.equal(collector.size, 0)
    } finally { pause.release(); await collector.stop() }
  })
})

await test('a persisted cap survives two stop and reopen cycles without further events or duplicate markers', async () => {
  await withTempDir('panel-recovery-sealed-prefix', async cwd => {
    const id = 'capped', captured = session(cwd, id)
    const first = createPanelCollector({ config, env, now: () => time })
    try {
      first.observe(captured, event('x'.repeat(70000), 0))
      await first.merge(id)
      assert.equal(data(cwd, id).limits.droppedEvents, 1)
    } finally { await first.stop() }
    const original = fs.readFileSync(walPath(cwd, id), 'utf8')
    assert.deepEqual(parseAppendLog(original).records.map(value => value.record), ['open', 'capped'])
    for (let cycle = 0; cycle < 2; cycle++) {
      const pause = pausedRead(walPath(cwd, id)), warnings = []
      const collector = createPanelCollector({ config, env, io: pause.io, now: () => time, report: value => warnings.push(value) })
      try {
        collector.observe(captured, event('queued while recovering', 1 + cycle * 3))
        collector.observe(captured, event('y'.repeat(70000), 2 + cycle * 3))
        await pause.entered; pause.release(); await collector.flush()
        collector.observe(captured, event('after recovery', 3 + cycle * 3))
        await collector.merge(id)
        assert.equal(fs.readFileSync(walPath(cwd, id), 'utf8'), original, 'a persisted cap keeps the original log byte-for-byte')
        assert.deepEqual(boundedLog(walPath(cwd, id)), [])
        const document = data(cwd, id)
        assert.equal(document.limits.truncated, true)
        assert.equal(document.limits.droppedEvents, 3, 'each activation counts only its three newly rejected events')
        assert.equal(document.metrics.eventCount, 0)
        assert.deepEqual(warnings, [])
      } finally { pause.release(); await collector.stop() }
      assert.equal(fs.readFileSync(walPath(cwd, id), 'utf8'), original, 'stop retains the same single-marker log')
    }
  })
})

await test('cap-like payload text and malformed records do not close an uncapped recovered log', async () => {
  await withTempDir('panel-recovery-marker-shape', async cwd => {
    const id = 'marker-shape', prior = seed(cwd, id)
    const markerText = '{"record":"capped","limitBytes":65536}'
    fs.appendFileSync(walPath(cwd, id), wire(record(markerText, prior.count)) + wire([JSON.parse(markerText)]) + 'broken ' + markerText + '\n')
    const collector = createPanelCollector({ config, env })
    try {
      collector.observe(session(cwd, id), event('still captured', prior.count + 1))
      await collector.merge(id)
      const document = data(cwd, id)
      assert.deepEqual(document.conversation.slice(-2).map(row => row.text), [markerText, 'still captured'])
      assert.equal(document.limits.truncated, false)
      assert.equal(document.limits.droppedEvents, 0)
      assert.equal(document.events.malformed, 2)
      assert.equal(document.verify.degraded, true)
      assert.equal(document.metrics.usageReported, false)
    } finally { await collector.stop() }
  })
})

await test('a fresh session charges its header before a queued near-limit event', async () => {
  await withTempDir('panel-recovery-fresh', async cwd => {
    const id = 'fresh', pause = pausedRead(walPath(cwd, id))
    const collector = createPanelCollector({ config, env, io: pause.io, now: () => time })
    try {
      collector.observe(session(cwd, id), event('n'.repeat(65336), 0))
      await pause.entered; pause.release(); await collector.merge(id)
      assert.deepEqual(boundedLog(walPath(cwd, id)), [], 'the event fits alone but cannot fit beside the required header')
      const document = data(cwd, id)
      assert.equal(document.meta.sessionId, id)
      assert.equal(document.limits.truncated, true)
      assert.equal(document.limits.droppedEvents, 1)
    } finally { pause.release(); await collector.stop() }
  })
})

await test('recovered JSON parse losses remain visible through merge and sealing', async () => {
  await withTempDir('panel-recovery-malformed', async cwd => {
    const id = 'malformed', prior = seed(cwd, id)
    fs.appendFileSync(walPath(cwd, id), 'not a complete JSON record\n')
    const collector = createPanelCollector({ config, env })
    try {
      collector.observe(session(cwd, id), event('after recovery', prior.count))
      await collector.merge(id)
      const merged = data(cwd, id)
      assert.equal(merged.events.malformed, 1)
      assert.equal(merged.verify.degraded, true)
      assert.equal(merged.metrics.usageReported, false)
      assert.equal(merged.conversation.at(-1).text, 'after recovery')
      await collector.close(id)
      const sealed = data(cwd, id)
      assert.equal(sealed.verify.degraded, true)
      assert.equal(sealed.metrics.usageReported, false)
      assert.equal(fs.existsSync(walPath(cwd, id)), false)
    } finally { await collector.stop() }
  })
})

/** Existing materialised files must survive an activation that cannot open its log. */
function existingOutput(cwd, id) {
  fs.mkdirSync(directory(cwd), { recursive: true })
  fs.writeFileSync(path.join(directory(cwd), id + '.json'), '{"previous":"capture"}\n')
  fs.writeFileSync(path.join(directory(cwd), 'panel.html'), '<html>previous viewer</html>\n')
  return () => Object.fromEntries(fs.readdirSync(directory(cwd)).sort()
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(directory(cwd), file))).digest('hex')]))
}

await test('a refused recovery read blocks queued and later writes, folds and sealing', async () => {
  await withTempDir('panel-recovery-read-failed', async cwd => {
    const id = 'read-failed', prior = seed(cwd, id, config.maxSessionBytes - 2000)
    const snapshot = existingOutput(cwd, id), original = snapshot(), warnings = []
    const denied = Object.assign(new Error('fixture refuses the initial recovery read'), { code: 'EACCES' })
    const pause = pausedRead(walPath(cwd, id), denied)
    const collector = createPanelCollector({ config, env, io: pause.io, report: value => warnings.push(value) })
    const captured = session(cwd, id)
    try {
      collector.observe(captured, event('queued ' + 'x'.repeat(5000), prior.count))
      collector.observe(captured, event('y'.repeat(70000), prior.count + 1))
      collector.observe(captured, { type: 'turn/end', seq: prior.count + 2, time, data: {} })
      await pause.entered; pause.release(); await collector.flush()
      const afterQueued = snapshot()
      collector.observe(captured, event('after failed recovery', prior.count + 3))
      collector.observe(captured, { type: 'turn/end', seq: prior.count + 4, time, data: {} })
      await collector.merge(id)
      const afterLater = snapshot()
      await collector.close(id)
      assert.deepEqual(afterQueued, original, 'an unknown recovered size never permits queued appends or cap markers')
      assert.deepEqual(afterLater, original, 'later events and explicit merges keep the failed capture untouched')
      assert.deepEqual(snapshot(), original, 'close must not seal or remove a log that failed recovery')
      assert.deepEqual(pause.writes, [])
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /capture failed \(open\): fixture refuses the initial recovery read/)
      assert.equal(collector.size, 0)
    } finally { pause.release(); await collector.stop() }
  })
})

await test('a failed new-session header write blocks the same queued and later work', async () => {
  await withTempDir('panel-recovery-header-failed', async cwd => {
    const id = 'header-failed', snapshot = existingOutput(cwd, id), original = snapshot(), warnings = []
    const wal = walPath(cwd, id), pause = pausedRead(wal), appendFile = pause.io.appendFile
    let attempts = 0
    pause.io.appendFile = async (file, ...args) => {
      if (String(file) === wal && attempts++ === 0) {
        throw Object.assign(new Error('fixture refuses the initial header write'), { code: 'EIO' })
      }
      return appendFile(file, ...args)
    }
    const collector = createPanelCollector({ config, env, io: pause.io, report: value => warnings.push(value) })
    const captured = session(cwd, id)
    try {
      collector.observe(captured, event('queued', 0))
      collector.observe(captured, event('y'.repeat(70000), 1))
      collector.observe(captured, { type: 'turn/end', seq: 2, time, data: {} })
      await pause.entered; pause.release(); await collector.flush()
      const afterQueued = snapshot()
      collector.observe(captured, event('after failed header write', 3))
      collector.observe(captured, { type: 'turn/end', seq: 4, time, data: {} })
      await collector.merge(id)
      const afterLater = snapshot()
      await collector.close(id)
      assert.deepEqual(afterQueued, original, 'a failed header cannot be followed by events, caps or replacement output')
      assert.deepEqual(afterLater, original)
      assert.deepEqual(snapshot(), original, 'close keeps previous output and never creates an orphaned event log')
      assert.equal(attempts, 1, 'only the failed initial header append was issued')
      assert.deepEqual(pause.writes, ['mkdir'], 'no further write starts after initialization fails')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /capture failed \(open\): fixture refuses the initial header write/)
      assert.equal(collector.size, 0)
    } finally { pause.release(); await collector.stop() }
  })
})

await test('stop during recovery waits for the issued read and never appends or folds queued events', async () => {
  await withTempDir('panel-recovery-stop', async cwd => {
    const id = 'stopped', prior = seed(cwd, id), pause = pausedRead(walPath(cwd, id)), warnings = []
    const collector = createPanelCollector({ config, env, io: pause.io, report: value => warnings.push(value) })
    const captured = session(cwd, id)
    try {
      collector.observe(captured, event('queued', prior.count))
      collector.observe(captured, { type: 'turn/end', seq: prior.count + 1, time, data: {} })
      await pause.entered
      let settled = false
      const stopping = collector.stop().then(() => { settled = true })
      await Promise.resolve()
      assert.equal(settled, false, 'the component still owns its in-flight recovery read')
      collector.observe(captured, event('after stop', prior.count + 2))
      pause.release(); await stopping
      assert.deepEqual(pause.writes, [])
      assert.equal(fs.readFileSync(walPath(cwd, id), 'utf8'), prior.text)
      assert.deepEqual(fs.readdirSync(directory(cwd)), [id + '.ndjson'])
      assert.deepEqual(warnings, [], 'intentional stop is not reported as a capture failure')
      assert.equal(collector.size, 0)
    } finally { pause.release(); await collector.stop() }
  })
})

report('panel-recovery')
