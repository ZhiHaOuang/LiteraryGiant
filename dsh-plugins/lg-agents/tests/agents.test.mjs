import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createAgents } from '../src/service.js'
import { parseResult, segments } from '../src/tasks.js'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

function setup(output, duringRun = () => {}) {
  const path = mkdtempSync(join(tmpdir(), 'lg-agents-')); createBook(path).db.close()
  const config = { provider: 'test', model: 'fiction', inputCnyPerMillion: 1, outputCnyPerMillion: 2, maxOutputTokens: 4096, maxInputBytes: 16000 }
  const execution = { preview: input => new Executor(null, null, config).preview(input),
    async run(id) { duringRun({ path, read: () => readManuscript(path, 1) }); return { id, status: 'succeeded', result: { text: output } } } }
  const books = { manuscript: readManuscript, candidate: (path, input, generation) => writeManuscript(path, { ...input, action: 'candidate' }, generation) }
  const agents = createAgents(books, execution, { roles: [] }), snapshot = readManuscript(path, 1)
  const input = { task: 'polish', path, document: 1, version: snapshot.selected.id, start: 0, end: 6,
    token: snapshot.token, request: '保持事件，调整节奏。', operation: randomUUID() }
  return { agents, input, snapshot, path, execution, books }
}
test('scoped polish creates only a candidate and preserves all text outside the selection', async () => {
  const s = setup(JSON.stringify({ replacement: '林澈轻轻关上灯。', notes: '放慢动作。' }))
  const plan = s.agents.preview(s.input)
  assert.equal(plan.source.text, s.snapshot.selected.content.slice(0, 6))
  assert.ok(!plan.modelInput.input.includes('海风停了'))
  const result = await s.agents.run({ ...s.input, signature: plan.signature })
  const candidate = readManuscript(s.path, 1, result.candidate.version)
  assert.equal(candidate.document.activeVersion, 1)
  assert.equal(candidate.selected.content, '林澈轻轻关上灯。' + s.snapshot.selected.content.slice(6))
  assert.equal(candidate.selected.metadata.generation.run, s.input.operation)
})
test('modified preview, invalid scope and disabled role fail before model execution', async () => {
  const s = setup('{}'), plan = s.agents.preview(s.input)
  await assert.rejects(s.agents.run({ ...s.input, request: '换个任务', signature: plan.signature }), /重新预览/)
  assert.throws(() => s.agents.preview({ ...s.input, end: 100000 }), /精确非空范围/)
  const disabled = createAgents(s.books, s.execution, { roles: [{ id: 'manuscript-editor', enabled: false }] })
  assert.throws(() => disabled.preview(s.input), /已停用/)
  assert.equal(s.agents.roles().filter(role => role.enabled).length, 5)
})
test('same manuscript in another directory produces a different bound request', () => {
  const a = setup('{}'), b = setup('{}')
  assert.notEqual(a.agents.preview(a.input).modelInput.scope, b.agents.preview(b.input).modelInput.scope)
})
test('review evidence must be exact, unique and tied to its source version', () => {
  const source = { document: 1, version: 3, start: 10, text: '林澈关灯。海风停了。' }
  const value = { issues: [{ category: '节奏', evidence: [2], message: '转折过快。', suggestion: '补充可感知的停顿。' }] }
  const result = parseResult('review', JSON.stringify(value), source)
  assert.deepEqual(result.issues[0].evidence, [{ document: 1, version: 3, start: 15, end: 20, quote: '海风停了。' }])
  value.issues[0].evidence = [999]
  assert.throws(() => parseResult('review', JSON.stringify(value), source), /证据编号/)
})
test('change during generation leaves output available without creating stale candidate', async () => {
  const s = setup(JSON.stringify({ replacement: '新文字。', notes: '调整' }), ({ path, read }) => {
    writeManuscript(path, { action: 'edit', document: 1, token: read().token, content: '作者先改了正文。', reason: '并发编辑', operation: randomUUID() })
  })
  const result = await s.agents.run({ ...s.input, signature: s.agents.preview(s.input).signature })
  assert.match(result.candidateError, /正文发生变化/)
  assert.equal(result.output.replacement, '新文字。')
  assert.equal(result.candidate, undefined)
})
test('invalid structured model output does not become a manuscript version', async () => {
  const s = setup('只有说明，没有结构化结果。')
  const result = await s.agents.run({ ...s.input, signature: s.agents.preview(s.input).signature })
  assert.ok(result.validationError)
  assert.equal(result.status, 'invalid-output')
  assert.equal(readManuscript(s.path, 1).versions.length, 2)
})
test('real-model failure: malformed nested quotes and changed source punctuation are rejected', () => {
  const source = { document: 1, version: 1, start: 0, text: '她想起信里那句“午夜前，不要让妹妹登船”。' }
  assert.throws(() => parseResult('review', '{"issues":[{"suggestion":"改为"她预感""}]}', source), SyntaxError)
  const value = { issues: [{ category: '人物', quote: "她想起信里那句'午夜前，不要让妹妹登船'", message: '信息越界', suggestion: '调整' }] }
  assert.throws(() => parseResult('review', JSON.stringify(value), source), /证据编号/)
})
test('numbered evidence reconstructs exact punctuation, whitespace and repeated phrases', () => {
  const source = { start: 10, text: '她说：“回来！”\n\n回来。回来。最后一句' }
  const parts = segments(source)
  assert.equal(parts.map(part => part.text).join(''), source.text)
  for (const part of parts) assert.equal(source.text.slice(part.start - 10, part.end - 10), part.text)
  assert.equal(new Set(parts.map(part => part.id)).size, parts.length)
})

test('whole-chapter generation includes the complete current body and saves only a candidate', async () => {
  const s = setup(JSON.stringify({ replacement: '雨夜里，林澈收好信封。\n\n她走向门边，停住了。', notes: '完整章节候选。' }))
  const input = { ...s.input, task: 'draft-chapter', end: s.snapshot.selected.content.length }
  const plan = s.agents.preview(input)
  assert.equal(plan.role, 'chapter-writer'); assert.equal(plan.scope, 'chapter-body')
  assert.equal(plan.source.text, s.snapshot.selected.content)
  const before = s.snapshot.parts
  const result = await s.agents.run({ ...input, signature: plan.signature })
  assert.equal(result.status, 'candidate-ready')
  const after = readManuscript(s.path, 1, result.candidate.version)
  assert.equal(after.document.content, s.snapshot.document.content)
  assert.deepEqual(after.parts, before)
  assert.equal(after.selected.content, result.output.replacement)
  assert.equal(after.selected.metadata.generation.task, 'draft-chapter')
})

test('empty chapters can be drafted without accepting an empty or partial chapter result', async () => {
  const s = setup(JSON.stringify({ replacement: '第一章从这场雨开始。', notes: '待作者审读。' }))
  writeManuscript(s.path, { action: 'edit', document: 1, token: s.snapshot.token, content: '', reason: '合成空章', operation: randomUUID() })
  const body = readManuscript(s.path, 1), input = { ...s.input, task: 'draft-chapter', version: body.selected.id, token: body.token, start: 0, end: 0 }
  const plan = s.agents.preview(input), result = await s.agents.run({ ...input, signature: plan.signature })
  assert.equal(result.status, 'candidate-ready'); assert.equal(readManuscript(s.path, 1).document.content, '')
  assert.equal(readManuscript(s.path, 1, result.candidate.version).selected.content, '第一章从这场雨开始。')
  assert.throws(() => parseResult('draft-chapter', JSON.stringify({ replacement: '', notes: '' }), plan.source), /契约/)
})

test('chapter task refuses partial scopes, historical versions, unsupported feedback and disabled writers before dispatch', () => {
  const s = setup('{}'), input = { ...s.input, task: 'draft-chapter', end: s.snapshot.selected.content.length }
  assert.throws(() => s.agents.preview({ ...input, start: 1 }), /完整范围/)
  assert.throws(() => s.agents.preview({ ...input, end: 1 }), /完整范围/)
  const candidate = writeManuscript(s.path, { action: 'candidate', document: 1, sourceVersion: input.version, token: input.token,
    content: '未采纳版本。', reason: '合成候选', operation: randomUUID() })
  assert.throws(() => s.agents.preview({ ...input, version: candidate.version, end: 6 }), /当前章节正文版本/)
  const disabled = createAgents(s.books, s.execution, { roles: [{ id: 'chapter-writer', enabled: false }] })
  assert.throws(() => disabled.preview(input), /已停用/)
  assert.throws(() => s.agents.preview({ ...input, feedback: { run: 'unknown', issues: [1] } }), /反馈改稿/)
})

test('a concurrent chapter edit retains the model result without saving a stale chapter candidate', async () => {
  const s = setup(JSON.stringify({ replacement: '完整的新章节。', notes: '候选' }), ({ path, read }) => {
    writeManuscript(path, { action: 'edit', document: 1, token: read().token, content: '作者的新正文。', reason: '并发编辑', operation: randomUUID() })
  })
  const input = { ...s.input, task: 'draft-chapter', end: s.snapshot.selected.content.length }
  const result = await s.agents.run({ ...input, signature: s.agents.preview(input).signature })
  assert.equal(result.status, 'candidate-pending'); assert.equal(result.output.replacement, '完整的新章节。')
  assert.equal(result.candidate, undefined); assert.equal(readManuscript(s.path, 1).document.content, '作者的新正文。')
})

test('live Cordis role edits invalidate only affected previews', async () => {
  const s=setup('{}'),ctx=new Context()
  let calls=0
  const deps=ctx.plugin(c=>{
    c.provide('literaryBooks',s.books)
    c.provide('literaryExecution',{...s.execution,run(){calls++;throw new Error('unexpected dispatch')}})
  })
  await deps.await()
  const role='manuscript-editor', style={id:'style',instructions:'短句。'}
  const fiber=ctx.plugin(plugin,{roles:[style]});await fiber.await()
  try {
    const previous=ctx.literaryAgents.preview(s.input)
    const other=ctx.literaryAgents.preview({...s.input,role:'style'})
    await fiber.update({roles:[style,{id:role,instructions:'保留海风声。'}]})
    const current=ctx.literaryAgents.preview(s.input)
    assert.match(current.modelInput.system,/保留海风声/)
    assert.notEqual(current.signature,previous.signature)
    assert.equal(ctx.literaryAgents.preview({...s.input,role:'style'}).signature,other.signature)
    await assert.rejects(ctx.literaryAgents.run({...s.input,signature:previous.signature}),/重新预览/)
    await fiber.update({roles:[style,{id:role,enabled:false,instructions:'保留海风声。'}]})
    assert.equal(ctx.literaryAgents.roles().find(x=>x.id===role).enabled,false)
    await assert.rejects(ctx.literaryAgents.run({...s.input,signature:current.signature}),/停用/)
    assert.equal(calls,0)
  } finally {await fiber.dispose();await deps.dispose()}
})
