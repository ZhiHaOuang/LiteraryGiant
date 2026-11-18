#!/usr/bin/env node
/** Opt-in deterministic release gates. A failed or unavailable gate exits nonzero. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { formatReport } from './report.mjs'
import { verdict, fullAcceptance } from './metrics.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
export function parse(argv) {
  const options = { tasks: [], worker: path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker') }
  for (let i = 0; i < argv.length; ++i) {
    const key = argv[i]
    if (key === '--help' || key === '-h') { options.help = true; continue }
    const field = { '--worker': 'worker', '--baseline-source': 'baselineSource', '--baseline-worker': 'baselineWorker', '--output': 'output', '--task': 'task' }[key]
    if (!field || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown or incomplete argument: ' + key)
    const value = argv[++i]
    if (field === 'task') {
      if (!/^BM-0[1-5]$/.test(value)) throw new Error('Unknown benchmark task: ' + value)
      if (!options.tasks.includes(value)) options.tasks.push(value)
    } else options[field] = path.resolve(value)
  }
  if (!options.tasks.length) options.tasks = ['BM-01', 'BM-02', 'BM-03', 'BM-04', 'BM-05']
  if (!options.help && !options.output) throw new Error('--output is required; evidence files are never overwritten')
  return options
}
export async function main(argv, io = { out: console.log, err: console.error }) {
  let options
  try { options = parse(argv) } catch (error) { io.err(String(error)); return 2 }
  if (options.help) { io.out('node bench/cli.mjs gates --output report.json [--worker PATH] [--baseline-source PATH --baseline-worker PATH] [--task BM-01]'); return 0 }
  const markdown = options.output + '.md'
  if (fs.existsSync(options.output) || fs.existsSync(markdown)) { io.err('Refusing to overwrite evidence: ' + options.output); return 2 }
  if (!fs.existsSync(options.worker)) { io.err('Build the candidate worker first: ' + options.worker); return 2 }
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bm040-')))
  // Set only the dedicated DSH home; never mutate the operator HOME or profile.
  process.env.DSH_HOME = path.join(temporary, 'dsh-home'); fs.mkdirSync(process.env.DSH_HOME)
  const { bm01, bm02, bm03, bm05 } = await import('./tasks.mjs'), { bm04 } = await import('./pdf.mjs')
  const { baselineProvenance } = await import('./provenance.mjs')
  const report = { format: 'ops-040-gates-v1', createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, hostVersion: '0.2.0-rc.2', model: 'scripted, no network or paid model calls', temporary,
    candidateRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    candidateWorktreeStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
    fixtureSourceSha256: createHash('sha256').update(fs.readFileSync(new URL('./fixtures.mjs', import.meta.url))).digest('hex'),
    candidateWorker: { path: options.worker, sha256: createHash('sha256').update(fs.readFileSync(options.worker)).digest('hex') }, gates: [] }
  const tasks = { 'BM-01': bm01, 'BM-02': bm02, 'BM-03': bm03, 'BM-04': bm04, 'BM-05': bm05 }
  for (const id of options.tasks) {
    io.out('Running ' + id)
    try {
      if (id === 'BM-01') report.baseline = baselineProvenance(options.baselineSource, options.baselineWorker)
      report.gates.push(await tasks[id]({ ...options, temporary }))
    } catch (error) { report.gates.push({ id, status: 'failed', error: String(error?.stack ?? error) }) }
    io.out(id + ': ' + report.gates.at(-1).status)
  }
  report.passed = verdict(report.gates)
  report.selectedTasks = options.tasks
  report.fullAcceptance = fullAcceptance(report.gates)
  // Retain the exclusively owned temporary fixtures for inspection; no broad cleanup.
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(markdown, formatReport(report), { flag: 'wx' })
  io.out('Evidence: ' + options.output + ' and ' + markdown)
  return report.passed ? 0 : 1
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2))
