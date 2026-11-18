import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { apply } from '../index.js'

test('model declarations use standard JSON Schema and execution refuses undelegated capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-schema-'))
  const paragraphs = ['这是测试正文。']
  const snapshotPath = join(dir, 'snapshot.json')
  writeFileSync(snapshotPath, JSON.stringify({ schema: 'lg.analysis-input.v1', bookId: 'book', chapter: 1, version: 'v1', paragraphs, sha256: createHash('sha256').update(JSON.stringify(paragraphs)).digest('hex') }))
  const definitions = []; let guard
  const ctx = { subagents: { deliverHostMessage() {} }, agents: { list: () => [] }, tools: { register(def) { definitions.push(def) }, guard(fn) { guard = fn } }, on() {}, effect() {} }
  apply(ctx, { snapshotPath })
  for (const def of definitions) {
    assert.equal(def.parameters.type, 'object')
    assert.ok(def.parameters.properties)
    assert.equal(def.parameters.additionalProperties, false)
  }
  const read = definitions.find(d => d.name === 'lg_read_chapter')
  assert.deepEqual(read.parameters.required, ['chapter'])
  assert.equal(read.parameters.properties.chapter.type, 'integer')
  const root = { session: { header: {} } }
  assert.equal(guard({ agent: root, name: 'lg_read_chapter', arguments: { chapter: 1 } }), undefined)
  for (const name of ['bash', 'agent_teams_reassign_task', 'agent_teams_delete', 'agent_teams_add_member']) assert.match(guard({ agent: root, name, arguments: {} }), /未授予/)
  assert.match(guard({ agent: root, name: 'lg_read_chapter', arguments: { chapter: 2 } }), /不允许/)
})
