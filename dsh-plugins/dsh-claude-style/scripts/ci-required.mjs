#!/usr/bin/env node
/**
 * ci-required.mjs — the one check a branch rule names.
 *
 * A branch rule that lists every job has to be edited whenever a job is added or
 * renamed, and a job a rule does not name is a job a merge can skip. This reads
 * the `needs` the workflow hands it — the JSON `toJson(needs)` produces, one
 * entry per job with that job's `result` — and fails when any of them reports
 * neither `success` nor `skipped`, so the rule names this one check and the jobs
 * stay free to be added, renamed or removed.
 *
 * A job that was skipped is a pass here, which is what lets a push that touched
 * no code answer green with its lanes left out. A job the workflow leaves out of
 * `needs` never reaches this check, and the branch rule cannot catch it, so the
 * list is what a new job is added to.
 *
 * Usage: node scripts/ci-required.mjs '<toJson(needs)>'
 */
const needs = JSON.parse(process.argv[2] ?? '{}')
const entries = Object.entries(needs)
if (entries.length === 0) {
  console.error('ci-required: no job was handed over; the workflow must pass `needs` in')
  process.exit(2)
}
for (const [job, state] of entries) console.log(`ci-required: ${job} — ${state.result}`)
// A job the workflow's own `if` left out reports `skipped`, which is the answer
// a push that touched no code gets; a cancelled or failed job is not.
const failed = entries.filter(([, state]) => state.result !== 'success' && state.result !== 'skipped')
if (failed.length > 0) {
  console.error(`ci-required: ${failed.map(([job]) => job).join(', ')} did not pass`)
  process.exit(1)
}
console.log(`ci-required: every one of ${entries.length} jobs passed`)
