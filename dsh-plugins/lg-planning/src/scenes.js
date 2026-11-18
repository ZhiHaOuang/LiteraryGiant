import { doc, text, integer, shape, hash, now, createDocument } from './common.js'
const fields = ['pov', 'narrative_tense', 'time_label', 'location', 'goal', 'conflict', 'required_information', 'emotional_change', 'end_state']
function card(input) {
  shape(input, [...fields, 'characters', 'word_min', 'word_max'])
  const value = Object.fromEntries(fields.map(key => [key, text(input[key] ?? '', key, 4000, true).trim()]))
  if (!Array.isArray(input.characters ?? []) || (input.characters ?? []).length > 30) throw new Error('场景人物最多 30 项。')
  value.characters = [...new Set((input.characters ?? []).map(item => text(item, '人物名', 100).trim()))]
  value.word_min = input.word_min == null ? null : integer(input.word_min, 0, 1000000)
  value.word_max = input.word_max == null ? null : integer(input.word_max, 1, 1000000)
  if (value.word_min !== null && value.word_max !== null && value.word_min > value.word_max) throw new Error('最少字数不能超过最多字数。')
  return value
}
export function scene(db, id) {
  const d = doc(db, id, 'scene'), value = db.prepare('SELECT * FROM scene_cards WHERE document_id=?').get(id)
  if (!value || value.chapter_id !== d.parent_id) throw new Error('场景卡缺失或章节身份不一致。')
  if (value.chapter_id !== null) doc(db, value.chapter_id, 'chapter')
  const metadata = JSON.parse(value.metadata_json), normalized = card({ ...Object.fromEntries(fields.map(key => [key, value[key]])),
    characters: JSON.parse(value.characters_json), word_min: value.word_min, word_max: value.word_max })
  text(value.plan, '场景计划', 16000, true)
  if (!['empty', 'candidate', 'approved'].includes(value.plan_state)) throw new Error('场景计划状态无效。')
  const result = { document_id: id, slug: d.slug, title: d.title, chapter_id: d.parent_id, sequence: d.sequence,
    active_version_id: d.active_version_id, tags: db.prepare("SELECT tag FROM entity_tags WHERE owner_type='document' AND owner_id=? ORDER BY tag").all(id).map(row => row.tag), ...normalized, status: value.status, plan: value.plan, plan_state: value.plan_state, metadata }
  if (metadata.lg_plan_proposal) {
    const proposal = metadata.lg_plan_proposal
    shape(proposal, ['plan', 'basis', 'created_at', 'generation']); text(proposal.plan, '待审计划', 16000)
    if (typeof proposal.basis !== 'string' || !/^[a-f0-9]{64}$/u.test(proposal.basis)) throw new Error('待审计划来源无效。')
  }
  return { ...result, token: hash(result) }
}
const basis = item => hash(Object.fromEntries(['document_id', 'chapter_id', 'sequence', 'active_version_id', ...fields, 'characters', 'word_min', 'word_max', 'plan', 'plan_state'].map(key => [key, item[key]])))
export function planScene(db, input) {
  if (input.action === 'scene.create') {
    const chapter = input.chapter_id == null ? null : doc(db, input.chapter_id, 'chapter')
    const slug = text(input.slug, '场景标识', 200), title = text(input.title, '场景标题', 200), sequence = input.sequence == null ? null : integer(input.sequence, 0, 1000000)
    if (!/^[\p{L}\p{N}_-]+$/u.test(slug) || db.prepare('SELECT 1 FROM documents WHERE slug=?').get(slug)) throw new Error('场景标识无效或已存在。')
    const tags = input.tags ?? []
    if (!Array.isArray(tags) || tags.length > 30) throw new Error('标签最多 30 个。')
    for (const tag of tags) text(tag, '标签', 100)
    return { action: input.action, before: null, slug, title, tags, chapter_id: chapter?.id ?? null, sequence, after: { ...card(input.card ?? {}), plan: '', plan_state: 'empty', status: 'planned', metadata: {} } }
  }
  const before = scene(db, input.id)
  if (typeof input.expected_token !== 'string' || input.expected_token !== before.token) throw new Error('场景卡或正文版本已变化，请刷新。')
  const after = { ...before, metadata: { ...before.metadata } }
  if (input.action === 'scene.update') {
    Object.assign(after, card(input.card))
    // Changing a design invalidates the approval of that design, not its manuscript.
    if (before.plan_state === 'approved' && hash(card(Object.fromEntries([...fields, 'characters', 'word_min', 'word_max'].map(key => [key, before[key]])))) !== hash(card(input.card))) { after.plan_state = 'candidate'; after.status = 'planned' }
  } else if (input.action === 'scene.move') {
    after.chapter_id = input.chapter_id == null ? null : doc(db, input.chapter_id, 'chapter').id
    after.sequence = input.sequence == null ? null : integer(input.sequence, 0, 1000000)
    if ((after.chapter_id !== before.chapter_id || after.sequence !== before.sequence) && before.plan_state === 'approved') { after.plan_state = 'candidate'; after.status = 'planned' }
  } else if (input.action === 'scene.plan') {
    after.metadata.lg_plan_proposal = { plan: text(input.plan, '待审计划', 16000), basis: basis(before) }
  } else if (input.action === 'scene.approve') {
    const proposal = before.metadata.lg_plan_proposal
    if (proposal && proposal.basis !== basis(before)) throw new Error('待审计划所依据的场景卡或正文已变化，请重新提交计划。')
    if (proposal) {
      if (proposal.generation) after.metadata.lg_plan_generation = proposal.generation
      else delete after.metadata.lg_plan_generation
    }
    after.plan = proposal?.plan ?? before.plan
    if (!after.plan.trim()) throw new Error('请先提交非空计划。')
    if (!proposal && before.plan_state === 'approved') throw new Error('当前场景计划已经批准。')
    after.plan_state = 'approved'; after.status = 'approved'; delete after.metadata.lg_plan_proposal
  } else if (input.action === 'scene.discard') {
    if (!before.metadata.lg_plan_proposal) throw new Error('没有待审计划。')
    delete after.metadata.lg_plan_proposal
  } else if (input.action === 'scene.drafted') {
    const current = db.prepare('SELECT length(trim(content)) AS n FROM document_versions WHERE id=? AND document_id=?').get(before.active_version_id, before.document_id)
    if (!current?.n) throw new Error('场景尚无正文，不能标记已起草。')
    after.status = 'drafted'
  } else throw new Error('未知场景规划操作。')
  return { action: input.action, before, after }
}
export function applyScene(db, plan) {
  let id = plan.before?.document_id
  if (!id) {
    id = createDocument(db, { kind: 'scene', slug: plan.slug, title: plan.title, parent_id: plan.chapter_id, sequence: plan.sequence, tags: plan.tags })
    db.prepare("INSERT INTO scene_cards(document_id,chapter_id,status,created_at,updated_at) VALUES (?,?,'planned',?,?)").run(id, plan.chapter_id, now(), now())
  }
  const a = plan.after
  if (plan.action === 'scene.move') {
    db.prepare('UPDATE documents SET parent_id=?,sequence=?,updated_at=? WHERE id=?').run(a.chapter_id, a.sequence, now(), id)
    db.prepare('UPDATE scene_cards SET chapter_id=? WHERE document_id=?').run(a.chapter_id, id)
  }
  db.prepare(`UPDATE scene_cards SET ${fields.map(key => key + '=?').join(',')},characters_json=?,word_min=?,word_max=?,plan=?,plan_state=?,status=?,metadata_json=?,updated_at=? WHERE document_id=?`).run(
    ...fields.map(key => a[key]), JSON.stringify(a.characters), a.word_min, a.word_max, a.plan, a.plan_state, a.status, JSON.stringify(a.metadata), now(), id)
  return scene(db, id)
}
export const sceneFields = fields
