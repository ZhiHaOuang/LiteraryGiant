import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { accessState } from '../../lg-books/src/state.js'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { createMemory } from '../../lg-memory/src/service.js'
import { createContext } from '../../lg-context/src/service.js'
import { createPlanning } from '../src/service.js'
import { sceneFields } from '../src/scenes.js'

export function setup() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'lg-planning-'))); createBook(path).db.close()
  const books = { list: () => [{ path }], readState: (p, fn) => accessState(p, false, fn), changeState: (p, fn) => accessState(p, true, fn) }
  const planning = createPlanning(books), memory = createMemory(books), context = createContext(books, memory, () => planning)
  const apply = change => planning.apply(path, change, planning.preview(path, change).token, randomUUID())
  return { path, books, planning, memory, context, apply, write: fn => books.changeState(path, fn) }
}
export const options = extra => ({ action: 'decision.options', slug: 'letter-direction', title: '来信的方向', expected_version_id: 0,
  topic: { scope: 'chapter', document_id: 1, key: 'letter' }, sources: [{ document_id: 1, version_id: 1 }], request: '给出互不相同的三条剧情路径。',
  options: [{ id: 'a', title: '求证', content: '林澈去码头寻找送信人。' }, { id: 'b', title: '守候', content: '林澈留在灯塔等妹妹返回。' }, { id: 'c', title: '交付', content: '林澈把信交给船长保管。' }], ...extra })
const select = (v, id = 'a', number = v.options_version_number) => ({ action: 'decision.select', id: v.document_id, expected_version_id: v.version_id, options_version_number: number, option_id: id })
const sceneCreate = extra => ({ action: 'scene.create', slug: 'test-scene', title: '灯塔门前', chapter_id: 3, sequence: 1,
  card: { pov: '林澈', goal: '确认来信身份', conflict: '渡船即将离港', emotional_change: '怀疑转为决心', word_min: 100, word_max: 1000 }, ...extra })
const card = scene => Object.fromEntries([...sceneFields, 'characters', 'word_min', 'word_max'].map(key => [key, scene[key]]))

test('three distinct provisional directions preserve author selection and withdrawal never falls back', () => {
  const s = setup(), first = s.apply(options())
  assert.equal(first.selection, null); assert.equal(s.planning.context(s.path).items.length, 0)
  const picked = s.apply(select(first))
  assert.equal(picked.selection.content, options().options[0].content)
  assert.equal(s.memory.world(s.path).facts.length, 0)
  const revised = s.apply(options({ expected_version_id: picked.version_id, options: options().options.map(v => ({ ...v, content: '新方案：' + v.content })) }))
  assert.equal(revised.selection.options_version_id, first.options_version_id)
  assert.equal(revised.selection.content, first.options[0].content)
  const withdrawn = s.apply({ action: 'decision.withdraw', id: revised.document_id, expected_version_id: revised.version_id })
  assert.equal(withdrawn.selection, null); assert.equal(withdrawn.status, 'withdrawn'); assert.equal(s.planning.context(s.path).items.length, 0)
  const historical = s.apply(select(withdrawn, 'b', first.options_version_number))
  assert.equal(historical.selection.content, first.options[1].content)
})
test('exact head, exact option version, topic identity and sources are enforced', () => {
  const s = setup(), first = s.apply(options()), picked = s.apply(select(first))
  assert.throws(() => s.apply(select(first, 'b')), /版本已变化/)
  assert.throws(() => s.apply(select(picked, 'missing', 1)), /不属于/)
  assert.throws(() => s.apply(select(picked, 'b', 2)), /实际生成/)
  assert.throws(() => s.apply(options({ slug: 'another-topic' })), /主题已存在/)
  assert.throws(() => s.apply(options({ expected_version_id: picked.version_id, title: '换标题' })), /不能改变/)
  assert.throws(() => s.apply(options({ expected_version_id: picked.version_id, sources: [] })), /必须包含/)
  s.write(db => { db.prepare("UPDATE documents SET active_version_id=8 WHERE id=1").run() })
  const stale = s.planning.read(s.path, 'decisions', picked.document_id)
  assert.equal(stale.source_status, 'stale'); assert.equal(stale.status, 'selected')
  assert.throws(() => s.apply(select(stale, 'b', 1)), /来源已变化/)
  assert.equal(s.apply({ action: 'decision.withdraw', id: stale.document_id, expected_version_id: stale.version_id }).selection, null)
})
test('preview binds source bytes and retries are atomic without duplicate versions', () => {
  const s = setup(), change = options(), preview = s.planning.preview(s.path, change), operation = randomUUID()
  s.write(db => db.prepare("UPDATE document_versions SET content='作者先改了正文' WHERE id=1").run())
  assert.throws(() => s.planning.apply(s.path, change, preview.token, operation), /预览或来源已变化/)
  assert.equal(s.planning.list(s.path, 'decisions').total, 0)
  const fresh = s.planning.preview(s.path, change), first = s.planning.apply(s.path, change, fresh.token, operation)
  assert.deepEqual(s.planning.apply(s.path, change, fresh.token, operation), first)
  assert.throws(() => s.planning.apply(s.path, { ...change, title: 'changed' }, fresh.token, operation), /重复规划/)
  assert.equal(s.planning.history(s.path, first.document_id).versions.length, 1)
})
test('legacy sorted JSON remains readable and forged selected content fails closed', () => {
  const s = setup(), first = s.apply(options()), picked = s.apply(select(first))
  const sorted = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,sorted(x)])) : Array.isArray(v) ? v.map(sorted) : v
  s.write(db => { for (const row of db.prepare('SELECT id,content FROM document_versions WHERE document_id=?').all(first.document_id)) db.prepare('UPDATE document_versions SET content=? WHERE id=?').run(JSON.stringify(sorted(JSON.parse(row.content))), row.id) })
  const revised = s.apply(options({ expected_version_id: picked.version_id }))
  assert.equal(revised.selection.option_id, 'a')
  s.write(db => { const row = db.prepare('SELECT content FROM document_versions WHERE id=?').get(revised.version_id), data = JSON.parse(row.content); data.selection.content = '伪造已选内容'; db.prepare('UPDATE document_versions SET content=? WHERE id=?').run(JSON.stringify(data), revised.version_id) })
  assert.throws(() => s.planning.read(s.path, 'decisions', first.document_id), /历史方案不一致/)
  assert.equal(s.planning.context(s.path).invalid, 1)
})
test('invalid options and dependencies fail before writes; draft plan sources are allowed but not world facts', () => {
  const s = setup()
  for (const value of [options({ options: [] }), options({ options: [options().options[0], options().options[0], options().options[2]] }),
    options({ topic: { scope: 'work', document_id: 1, key: 'x' } }), options({ sources: [{ document_id: 1, version_id: 4 }] }),
    options({ topic: { scope: 'work', key: 'x' }, sources: [], request: '' })]) assert.throws(() => s.apply(value))
  const value = s.apply(options({ topic: { scope: 'chapter', document_id: 3, key: 'draft' }, sources: [{ document_id: 3, version_id: 3 }] }))
  assert.equal(s.apply(select(value)).source_status, 'current')
  assert.equal(s.memory.world(s.path).facts.length, 0)
})
test('scene pending replacement never overwrites approved plan; approval/discard are author-only', () => {
  const s = setup(), created = s.apply(sceneCreate()), proposal = { action: 'scene.plan', id: created.document_id, expected_token: created.token, plan: '确认目标，遇到阻碍，付出代价。' }
  const pending = s.planning.propose(s.path, proposal, randomUUID())
  assert.equal(pending.plan, ''); assert.equal(pending.plan_state, 'empty')
  const approved = s.apply({ action: 'scene.approve', id: pending.document_id, expected_token: pending.token })
  assert.equal(approved.plan, proposal.plan); assert.equal(approved.plan_state, 'approved')
  const replacement = s.planning.propose(s.path, { ...proposal, expected_token: approved.token, plan: '另一条待审路径。' }, randomUUID())
  assert.equal(replacement.plan, proposal.plan); assert.equal(replacement.plan_state, 'approved')
  for (const action of ['decision.select', 'decision.withdraw', 'scene.approve', 'scene.create', 'structure.create']) assert.throws(() => s.planning.propose(s.path, { action }, randomUUID()), /模型只能/)
  const discarded = s.apply({ action: 'scene.discard', id: replacement.document_id, expected_token: replacement.token })
  assert.equal(discarded.plan, proposal.plan); assert.equal(discarded.metadata.lg_plan_proposal, undefined)
})
test('changing scene design invalidates old approval and pending plan basis, without touching prose', () => {
  const s = setup(), created = s.apply(sceneCreate()), pending = s.apply({ action: 'scene.plan', id: created.document_id, expected_token: created.token, plan: '旧设计。' })
  const edited = s.apply({ action: 'scene.update', id: pending.document_id, expected_token: pending.token, card: { ...card(pending), conflict: '信封已经破损' } })
  assert.throws(() => s.apply({ action: 'scene.approve', id: edited.document_id, expected_token: edited.token }), /依据的场景卡/)
  const next = s.apply({ action: 'scene.plan', id: edited.document_id, expected_token: edited.token, plan: '针对破损信封的计划。' })
  const approved = s.apply({ action: 'scene.approve', id: next.document_id, expected_token: next.token })
  const revised = s.apply({ action: 'scene.update', id: approved.document_id, expected_token: approved.token, card: { ...card(approved), goal: '寻找失踪船长' } })
  assert.equal(revised.plan_state, 'candidate'); assert.equal(readManuscript(s.path, revised.document_id).selected.content, '')
  assert.throws(() => s.apply({ action: 'scene.drafted', id: revised.document_id, expected_token: revised.token }), /尚无正文/)
})
test('scene creation is atomic, validates word ranges, preserves tags and records design history', () => {
  const s = setup()
  assert.throws(() => s.apply(sceneCreate({ chapter_id: 6 })), /类型/)
  assert.throws(() => s.apply(sceneCreate({ card: { word_min: 300, word_max: 100 } })), /最少字数/)
  const scene = s.apply(sceneCreate({ tags: ['夜晚', '灯塔'] })), snapshot = readManuscript(s.path, scene.document_id)
  writeManuscript(s.path, { action: 'edit', document: scene.document_id, token: snapshot.token, content: '林澈推开门。', reason: '作者草稿', operation: randomUUID() })
  assert.throws(() => s.apply({ action: 'scene.plan', id: scene.document_id, expected_token: scene.token, plan: '基于旧版本' }), /正文版本已变化/)
  const current = s.planning.read(s.path, 'scenes', scene.document_id)
  assert.equal(s.apply({ action: 'scene.drafted', id: current.document_id, expected_token: current.token }).status, 'drafted')
  assert.equal(s.planning.history(s.path, current.document_id).operations.length, 2)
  assert.deepEqual(current.tags, ['夜晚', '灯塔'])
})
test('structure and rolling window expand only a bounded same-volume horizon', () => {
  const s = setup(), part = s.apply({ action: 'structure.create', kind: 'part', slug: 'part-2', title: '第二卷', sequence: 2 })
  const chapters = [1,2,3,4].map(sequence => s.apply({ action: 'structure.create', kind: 'chapter', slug: 'new-'+sequence, title: '新章'+sequence, parent_id: part.id, sequence }))
  const window = s.planning.window(s.path, { chapter_id: chapters[0].id, horizon: 2 })
  assert.deepEqual(window.chapters.map(c => c.id), chapters.slice(0,2).map(c => c.id)); assert.equal(window.hasMore, true)
  assert.equal(s.planning.list(s.path, 'structure', { limit: 2 }).nextOffset, 2)
  s.apply({ action: 'structure.create', kind: 'chapter', slug: 'ambiguous', title: '重复顺序', parent_id: part.id, sequence: 1 })
  assert.throws(() => s.planning.window(s.path, { chapter_id: chapters[0].id }), /有歧义/)
})
test('context emits selected direction only, excludes pending alternatives and detects withdrawal', () => {
  const s = setup(), selected = s.apply(select(s.apply(options())))
  const scene = s.apply(sceneCreate()), pending = s.apply({ action: 'scene.plan', id: scene.document_id, expected_token: scene.token, plan: 'UNAPPROVED_SCENE_SECRET' })
  const result = s.context.build(s.path, { decisions: true, chapter: 1, scene: scene.document_id, maxBytes: 8000 })
  assert.match(JSON.stringify(result.payload), /寻找送信人/)
  assert.doesNotMatch(JSON.stringify(result.payload), /UNAPPROVED_SCENE_SECRET|交给船长保管/)
  assert.equal(s.context.verify(s.path, result.receipt), true)
  assert.equal(s.context.build(s.path, { decisions: true, chapter: 3 }).payload.items.length, 0)
  s.apply({ action: 'decision.withdraw', id: selected.document_id, expected_version_id: selected.version_id })
  assert.throws(() => s.context.verify(s.path, result.receipt), /已变化/)
  assert.throws(() => s.context.build(s.path, { audience: 'reader', position: 1, decisions: true }), /混入/)
})

test('authors can resolve hierarchy ambiguity and attach orphan scenes using exact snapshots', () => {
  const s = setup(), orphan = s.apply(sceneCreate({ chapter_id: null }))
  const moved = s.apply({ action: 'scene.move', id: orphan.document_id, expected_token: orphan.token, chapter_id: 3, sequence: 5 })
  assert.equal(moved.chapter_id, 3); assert.equal(moved.sequence, 5)
  assert.equal(readManuscript(s.path, moved.document_id).document.kind, 'scene')
  assert.throws(() => s.apply({ action: 'scene.move', id: orphan.document_id, expected_token: orphan.token, chapter_id: 1 }), /已变化/)
  const chapter = s.planning.list(s.path, 'structure').items.find(item => item.id === 3)
  const updated = s.apply({ action: 'structure.update', id: chapter.id, expected_token: chapter.token, title: '改名后的第二章', parent_id: null, sequence: 20 })
  assert.equal(updated.title, '改名后的第二章'); assert.equal(updated.active_version_id, chapter.active_version_id)
  assert.equal(s.planning.window(s.path, { chapter_id: chapter.id }).chapters[0].id, chapter.id)
  assert.throws(() => s.apply({ action: 'structure.update', id: chapter.id, expected_token: chapter.token, title: '并发旧改动', sequence: 2 }), /已变化/)
})

test('one pinned option is included in full, retains its identity across new proposals, and respects scope and budget',()=>{
  const s=setup(),change=options({}),long='潮水上涨，林澈去寻找送信人。'.repeat(44)
  change.options[0].content=long
  const first=s.apply(select(s.apply(change))),pin={document_id:first.document_id,options_version_id:first.selection.options_version_id,option_id:'a'}
  const opts={chapter:1,direction:pin,maxBytes:4000,documents:[7]}
  const build=()=>s.context.build(s.path,opts),initial=build()
  assert.equal(initial.payload.items[0].text,long);assert.equal(initial.payload.items[0].truncated,false)
  assert.equal(initial.receipt.sources[0].identity.option_id,'a')
  assert.throws(()=>s.context.build(s.path,{...opts,maxBytes:1000}),/全文超过/)
  assert.throws(()=>s.context.build(s.path,{...opts,chapter:3}),/目标章/)
  assert.throws(()=>s.context.build(s.path,{...opts,audience:'reader',position:1}),/混入/)
  const updated=s.apply({...change,expected_version_id:first.version_id,options:options({}).options})
  assert.equal(s.context.verify(s.path,initial.receipt),true)
  const picked=s.apply(select(updated,'b'))
  assert.throws(build,/所选方向已变化/);assert.throws(()=>s.context.verify(s.path,initial.receipt),/已变化/)
  s.apply({action:'decision.withdraw',id:picked.document_id,expected_version_id:picked.version_id})
  assert.throws(build,/所选方向已变化/)
})
