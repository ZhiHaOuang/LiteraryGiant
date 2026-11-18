import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { validateSnapshot, validateAnalysis } from '../src/analysis.js'
const paragraphs = ['他一把抓起手令，说：“困了，改天再判，今天都散了吧！”']
const input = { schema: 'lg.analysis-input.v1', bookId: 'book', chapter: 1, version: 'v1', paragraphs, sha256: createHash('sha256').update(JSON.stringify(paragraphs)).digest('hex') }
const report = () => ({ schema: 'lg.analysis-candidate.v1', status: 'candidate', bookId: 'book', chapter: 1, version: 'v1', sha256: input.sha256, summary: '推迟审判', findings: [{ kind: 'observation', claim: '他推迟审判', evidence: [{ paragraph: 1, quote: '改天再判' }] }], unknowns: ['最终裁决尚未发生'] })
test('accepts a candidate with exact evidence from its pinned chapter', () => {
  assert.equal(validateSnapshot(input), input)
  assert.deepEqual(validateAnalysis(JSON.stringify(report()), input), report())
})
test('rejects stale version, canonical promotion, fabricated evidence and future paragraphs', () => {
  for (const mutate of [r => r.version = 'v2', r => r.status = 'canonical', r => r.findings[0].evidence[0].quote = '伪造内容', r => r.findings[0].evidence[0].paragraph = 2]) {
    const r = report(); mutate(r); assert.throws(() => validateAnalysis(JSON.stringify(r), input))
  }
  assert.throws(() => validateSnapshot({ ...input, paragraphs: ['被篡改'] }))
})
