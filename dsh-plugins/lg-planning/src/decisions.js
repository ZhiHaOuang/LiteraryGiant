import { doc, text, integer, hash, sha, sourceState, requireSources, createDocument, writeVersion } from './common.js'
import { kind, schema, topic, sources, options, payload, chosen } from './decision-schema.js'
function optionVersion(db, id, number) {
  const row = db.prepare('SELECT id,document_id,version_number,substr(content,1,65001) AS content FROM document_versions WHERE document_id=? AND version_number=?').get(id, integer(number))
  if (!row) throw new Error('指定的方案版本不存在。')
  const value = payload(row.content)
  if (value.operation !== 'options' || value.options_version_number !== row.version_number) throw new Error('请选择实际生成方案的版本。')
  return { version: row, value }
}
export function decision(db, id) {
  const d = doc(db, id, kind), version = db.prepare('SELECT id,document_id,version_number,substr(content,1,65001) AS content FROM document_versions WHERE id=? AND document_id=?').get(d.active_version_id, id)
  if (!version) throw new Error('创作方向当前版本身份无效。')
  const value = payload(version.content), original = optionVersion(db, id, value.options_version_number)
  const fields = ['topic', 'options', 'sources', 'request', 'request_sha256']
  if (fields.some(key => hash(value[key]) !== hash(original.value[key]))) throw new Error('当前方案与其历史版本不一致。')
  if (value.selection) {
    const selected = optionVersion(db, id, value.selection.options_version_number)
    if (hash(value.topic) !== hash(selected.value.topic) || hash(value.selection) !== hash(chosen(selected.version, selected.value, value.selection.option_id))) throw new Error('当前选择与历史方案不一致。')
  }
  const status = sourceState(db, value.selection?.sources ?? value.sources), provisional = sourceState(db, value.sources)
  return { document_id: id, slug: d.slug, title: d.title, version_id: version.id, version_number: version.version_number,
    ...value, status: value.selection_status, options_version_id: original.version.id,
    source_status: status.status, source_details: status.details, options_source_status: provisional.status, options_source_details: provisional.details }
}
function validateSources(db, t, list) {
  if (t.scope !== 'work') {
    doc(db, t.document_id, t.scope)
    if (!list.some(item => item.document_id === t.document_id)) throw new Error('范围目标必须包含在精确版本来源中。')
  }
  for (const item of list) if (doc(db, item.document_id).kind === kind) throw new Error('创作方向之间的依赖需要单独契约。')
  return requireSources(db, list)
}
export function planDecision(db, input) {
  if (input.action === 'decision.options') {
    const t = topic(input.topic), opts = options(input.options), refs = sources(input.sources ?? []), request = text(input.request ?? '', '创作要求', 8000, !!refs.length)
    const state = validateSources(db, t, refs), slug = text(input.slug, '文档标识', 200), title = text(input.title, '创作方向标题', 200).trim()
    if (!/^[\p{L}\p{N}_-]+$/u.test(slug)) throw new Error('文档标识只能包含文字、数字、下划线和连字符。')
    const existing = db.prepare('SELECT id FROM documents WHERE slug=?').get(slug), before = existing ? decision(db, existing.id) : null
    if (integer(input.expected_version_id, 0) !== (before?.version_id ?? 0)) throw new Error('创作方向版本已变化，请刷新。')
    if (before && (hash(before.topic) !== hash(t) || before.title !== title)) throw new Error('已有创作方向的主题和标题不能改变。')
    if (!before) {
      const peers = db.prepare("SELECT id FROM documents WHERE kind=? AND state NOT IN ('archived','rejected') ORDER BY id LIMIT 10001").all(kind)
      if (peers.length > 10000) throw new Error('创作方向数超过身份校验上限。')
      for (const peer of peers) if (hash(decision(db, peer.id).topic) === hash(t)) throw new Error('该主题已存在，请更新原创作方向。')
    }
    const number = before ? db.prepare('SELECT COALESCE(MAX(version_number),0)+1 AS n FROM document_versions WHERE document_id=?').get(before.document_id).n : 1
    return { action: input.action, before, slug, title, sources: state, after: { schema, operation: 'options', topic: t, options_version_number: number,
      options: opts, sources: refs, request, request_sha256: sha(request), selection: before?.selection ?? null, selection_status: before?.status ?? 'unselected' } }
  }
  const before = decision(db, input.id)
  if (integer(input.expected_version_id) !== before.version_id) throw new Error('创作方向版本已变化，请刷新。')
  const after = Object.fromEntries(['schema', 'operation', 'topic', 'options_version_number', 'options', 'sources', 'request', 'request_sha256', 'selection', 'selection_status'].map(key => [key, before[key]]))
  if (input.action === 'decision.withdraw') {
    if (!before.selection) throw new Error('没有当前选择可撤回。')
    return { action: input.action, before, after: { ...after, operation: 'withdraw', selection: null, selection_status: 'withdrawn' } }
  }
  if (input.action !== 'decision.select') throw new Error('未知创作方向操作。')
  const selected = optionVersion(db, before.document_id, input.options_version_number)
  if (hash(selected.value.topic) !== hash(before.topic)) throw new Error('历史方案主题不一致。')
  const state = validateSources(db, before.topic, selected.value.sources), selection = chosen(selected.version, selected.value, input.option_id)
  if (hash(selection) === hash(before.selection)) throw new Error('此精确方案已经选定。')
  return { action: input.action, before, sources: state, after: { ...after, operation: 'select', selection, selection_status: 'selected' } }
}
export function applyDecision(db, plan) {
  let id = plan.before?.document_id
  if (!id) {
    // First version is already the options record; never create an empty managed version.
    id = createDocument(db, { kind, slug: plan.slug, title: plan.title }, JSON.stringify(plan.after))
  } else writeVersion(db, id, JSON.stringify(plan.after), `Creative direction: ${plan.after.operation}`)
  return decision(db, id)
}
export function decisionContext(db, limit = 30, chapterId = null, decisionId) {
  integer(limit, 1, 100)
  const chapter = chapterId == null ? null : doc(db, chapterId, 'chapter')
  const rows = decisionId===undefined ? db.prepare("SELECT id FROM documents WHERE kind=? AND state NOT IN ('archived','rejected') ORDER BY id LIMIT 1001").all(kind) : [{id:integer(decisionId)}]
  const items = []; let considered = 0, invalid = 0
  for (const { id } of rows.slice(0, 1000)) {
    let value
    try { value = decision(db, id) } catch { invalid++; continue }
    const t = value.topic
    if (chapter && !(t.scope === 'work' || t.scope === 'chapter' && t.document_id === chapter.id || t.scope === 'part' && t.document_id === chapter.parent_id)) continue
    if (!value.selection) continue
    considered++
    if (items.length >= limit) continue
    const { request, ...selection } = value.selection
    items.push({ document_id: id, topic: t, selection, source_status: value.source_status, source_details: value.source_details })
  }
  return { items, truncated: rows.length > 1000 || considered > items.length, invalid,
    note: '作者选定方向是创作约束，不是世界事实；来源失效时需要复核。新候选不会取代已有选择。' }
}
