import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBook } from './fixture.mjs'
import { readManuscript } from '../src/manuscript.js'
import { writeManuscript } from '../src/write.js'

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'lg-write-test-'))
  createBook(path).db.close()
  const read = (doc = 1, version) => readManuscript(path, doc, version)
  const request = (action, extra = {}) => ({ action, operation: randomUUID(), document: 1,
    token: read().token, content: '林澈关上灯，却没有离开。', reason: '保留事件，只调整停顿。', ...extra })
  return { path, read, request, write: input => writeManuscript(path, input) }
}

test('candidate preserves active manuscript; author acceptance activates only the selected version', () => {
  const s = setup(), before = s.read(), result = s.write(s.request('candidate'))
  assert.equal(s.read().document.activeVersion, before.document.activeVersion)
  assert.equal(s.read(1, result.version).selected.state, 'candidate')
  const adopted = s.write(s.request('accept', { version: result.version }))
  assert.equal(adopted.sync, 'synchronized')
  assert.equal(s.read().document.activeVersion, result.version)
  assert.equal(s.read().selected.state, 'accepted')
})
test('author save creates a new version and leaves previous content available', () => {
  const s = setup(), before = s.read()
  s.write(s.request('edit'))
  assert.notEqual(s.read().document.activeVersion, before.document.activeVersion)
  assert.equal(s.read(1, before.document.activeVersion).selected.content, before.document.content)
})
test('same operation retries return original receipt without duplicating versions', () => {
  const s = setup(), input = s.request('edit'), first = s.write(input)
  assert.deepEqual(s.write(input), first)
  assert.equal(s.read().versions.length, 3)
  assert.throws(() => s.write({ ...input, content: '不同正文' }), /重复操作/)
})
test('changing a sibling scene invalidates the whole chapter snapshot and candidate', () => {
  const s = setup(), input = s.request('candidate'), candidate = s.write(input)
  s.write(s.request('edit', { document: 2, content: '场景已被作者改写。' }))
  assert.throws(() => s.write({ ...input, operation: randomUUID() }), /整章或场景已变化/)
  assert.throws(() => s.write(s.request('accept', { version: candidate.version })), /候选来源已经变化/)
})
test('rejected candidates cannot be adopted; active prose cannot be rejected', () => {
  const s = setup(), candidate = s.write(s.request('candidate'))
  s.write(s.request('reject', { version: candidate.version }))
  assert.throws(() => s.write(s.request('accept', { version: candidate.version })), /尚未采用/)
  assert.throws(() => s.write(s.request('reject', { version: s.read().document.activeVersion })), /尚未采用/)
})
test('legacy candidates fail closed until their original approval constraints are migrated', () => {
  const s = setup(), legacy = s.read().versions.find(v => v.state === 'candidate')
  assert.throws(() => s.write(s.request('accept', { version: legacy.id })), /旧审批规则/)
  assert.equal(s.read().document.activeVersion, 1)
})
test('wrong document/version, missing snapshot and oversized writes do not modify manuscript', () => {
  const s = setup(), before = s.read()
  assert.throws(() => s.read(1, 4), /版本不存在/)
  assert.throws(() => s.read(6), /章节或场景/)
  for (const extra of [{ token: '' }, { document: '1' }, { content: '字'.repeat(400001) }, { reason: '' }, { operation: 'x' }]) {
    assert.throws(() => s.write(s.request('edit', extra)))
  }
  assert.deepEqual(s.read(), before)
})
