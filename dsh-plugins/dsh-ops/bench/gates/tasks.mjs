import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getEncoding } from 'js-tiktoken'
import { publicToolName } from '../../lib/policy.js'
import { verifyReads, verifyEmittedReads, lowerBound } from './metrics.mjs'
import { boot } from './host.mjs'
import { readAcceptance, startupAssessment, readControlPassed, rejectedWithoutEffects } from './integrity.mjs'
import { READ_CASES, readFixture, fiveEdits, hash } from './fixtures.mjs'
const calls = run => run.results.map(item => item.result)
const raw = (name, args) => ({ name, args })
const text = run => run.committed.map(item => item.text).join('\n')
/** One primary issue-declared task, plus a prespecified range/content sensitivity grid. */
export async function bm01(options) {
  const cases = []
  for (const scenario of READ_CASES) {
    const root = path.join(options.temporary, scenario.id); fs.mkdirSync(root)
    const files = readFixture(root, scenario), rows = {}
    for (const projection of ['candidate', 'baseline', 'official']) {
      const host = await boot({ ...options, root, projection, worker: projection === 'baseline' ? options.baselineWorker : options.worker })
      try {
        const owner = await host.agent(), ranges = files.map(({ path, offset, limit }) => ({ path, offset, limit }))
        const requests = projection === 'candidate' ? [[raw(publicToolName('read_files'), { files: ranges })]]
          : ranges.map(({ path, ...range }) => [raw(projection === 'official' ? 'read' : publicToolName('inspect_local_file'), { [projection === 'official' ? 'file_path' : 'path']: path, ...range })])
        const run = await host.run(owner, [...requests, []]); verifyReads(run, files, projection); verifyEmittedReads(run, files, projection)
        rows[projection] = { ...run, logicalLines: files.reduce((n, file) => n + file.expected.length, 0) }
        if (scenario.primary && projection !== 'candidate') {
          const parallel = await host.run(await host.agent(), [requests.flat(), []]); verifyReads(parallel, files, projection); verifyEmittedReads(parallel, files, projection)
          rows[projection + 'Parallel'] = parallel
        }
      } finally { await host.close() }
    }
    const savings = Object.fromEntries(['baseline', 'official'].map(name => [name, 1 - rows.candidate.outputBytes / rows[name].outputBytes]))
    cases.push({ scenario, files, rows, savings, lowerBound: lowerBound(files, rows), passes: { oneToolRound: rows.candidate.toolBearingRounds === 1,
      vs031: savings.baseline >= .4, vsOfficial: savings.official >= .4 } })
  }
  const primary = cases.find(item => item.scenario.primary)
  return { id: 'BM-01', status: readAcceptance(primary.savings, primary.rows.candidate.toolBearingRounds),
    criterion: 'One tool-bearing provider round; >=40% emitted text-byte reduction on predeclared 3×50 primary task against OPS 0.3.1. Official-reader comparison is reported separately and does not gate acceptance.',
    acceptanceBaseline: 'ops-0.3.1', officialComparisonGating: false, scopeDecision: 'User confirmed OPS 0.3.x as the authoritative baseline; official reader remains a separate comparator.',
    universalSavingsClaim: false, providerModel: 'scripted; no paid calls', cases }
}

export async function bm02(options) {
  const root = path.join(options.temporary, 'five-edits'); fs.mkdirSync(root)
  const fixture = fiveEdits(root), host = await boot({ ...options, root, alwaysLoaded: ['edit_file'] })
  try {
    const owner = await host.agent()
    const applied = await host.run(owner, [[raw(publicToolName('edit_file'), { path: fixture.path, expectedRevision: fixture.revision, edits: fixture.edits })], []])
    assert.equal(calls(applied)[0].isError, false); assert.equal(calls(applied)[0].value.status, 'completed')
    assert.equal(fs.readFileSync(fixture.path, 'utf8'), fixture.expected)
    assert.equal(applied.toolBearingRounds, 1)
    assert.equal(text(applied).includes(fixture.original), false); assert.equal(text(applied).includes(fixture.expected), false)
    // Stale expected revisions after external edits must never apply any of the five edits.
    const conflicts = []
    for (const suffix of ['\nexternal change', '\n另一个改动']) {
      const changed = fixture.original + suffix; fs.writeFileSync(fixture.path, changed)
      const run = await host.run(owner, [[raw(publicToolName('edit_file'), { path: fixture.path, expectedRevision: fixture.revision, edits: fixture.edits })], []])
      const result = calls(run)[0].value
      assert.equal(result.error?.code, 'REVISION_CONFLICT', JSON.stringify(result))
      assert.equal(fs.readFileSync(fixture.path, 'utf8'), changed)
      conflicts.push(run)
    }
    return { id: 'BM-02', status: 'passed', applied, conflicts, conflictDetection: { rejected: conflicts.length, attempted: conflicts.length },
      originalHash: fixture.revision, expectedHash: hash(fixture.expected), noFullFileEcho: true }
  } finally { await host.close() }
}

export async function bm03(options) {
  const root = path.join(options.temporary, 'startup'); fs.mkdirSync(root)
  const host = await boot({ ...options, root, withShell: process.platform === 'win32' })
  try {
    const run = await host.run(await host.agent(), [[]]), request = run.requests[0]
    const assessment = startupAssessment(request.tools)
    const messages = JSON.stringify(request.messages)
    return { id: 'BM-03', ...assessment,
      criterion: 'File/discovery resident schema <=400 tokens. Bash remains loaded at startup; exact full-default readiness is required and the full token total is reported separately.',
      acceptanceScope: 'file-discovery', scopeDecision: 'User confirmed the 400-token budget excludes Bash while keeping Bash resident.',
      reason: assessment.readiness.reason, shellReady: assessment.readiness.shellReady, shellFixture: host.shellFixture ?? null, platform: process.platform,
      wholeStartupMessages: { tokens: getEncoding('cl100k_base').encode(messages).length, bytes: Buffer.byteLength(messages), json: messages },
      methodology: 'js-tiktoken@1.0.21 cl100k_base over compact host name/description/parameters JSON, actual provider order; not provider billing.' }
  } finally { await host.close() }
}

export async function bm05(options) {
  const root = path.join(options.temporary, 'authority-workspace'), outside = path.join(options.temporary, 'outside')
  fs.mkdirSync(root); fs.mkdirSync(outside)
  const publicPath = path.join(outside, 'ordinary.txt'), secretPath = path.join(outside, '.env'), target = path.join(outside, 'deny-write.txt')
  fs.writeFileSync(publicPath, 'outside ordinary data'); fs.writeFileSync(secretPath, 'BENCHMARK_SECRET_BODY')
  const host = await boot({ ...options, root, alwaysLoaded: ['write_file'] })
  try {
    const owner = await host.agent()
    const read = await host.run(owner, [[raw(publicToolName('read_files'), { files: [{ path: publicPath }] })], []])
    const denied = await host.run(owner, [[raw(publicToolName('read_files'), { files: [{ path: secretPath }] })], []])
    const write = await host.run(owner, [[raw(publicToolName('write_file'), { path: target, content: 'MUST_NOT_APPEAR', expectedRevision: 'absent' })], []])
    const values = calls(read)[0].value.items, deniedRead = calls(denied)[0].value, deniedWrite = calls(write)[0].value
    const forbidden = [options.temporary, path.dirname(options.temporary), 'BENCHMARK_SECRET_BODY']
    const denialText = text(write) + text(denied)
    const gates = { ordinaryReadSucceeded: readControlPassed(calls(read)[0].value, publicPath, 'outside ordinary data'),
      writeRejected: rejectedWithoutEffects(deniedWrite, 'POLICY_DENIED'),
      secretRejected: rejectedWithoutEffects(deniedRead, 'CREDENTIAL_DENIED'), unchanged: !fs.existsSync(target) && fs.readFileSync(secretPath, 'utf8') === 'BENCHMARK_SECRET_BODY',
      noParentPathLeak: forbidden.every(value => !denialText.includes(value)) }
    return { id: 'BM-05', status: Object.values(gates).every(Boolean) ? 'passed' : 'failed', gates, read, denied, write,
      enforcement: 'Real host SandboxPolicy and fixed-operation OPS bridge/worker; no arbitrary-process confinement claim.',
      outsideOrdinaryRead: values.find(value => value.path === publicPath),
      scopeNote: 'The pinned host authorizes OS-readable ordinary outside reads. Only credential-fenced reads and workspace-escaping writes are unauthorized; this is not a blanket workspace read jail.' }
  } finally { await host.close() }
}
