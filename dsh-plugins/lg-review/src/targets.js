import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(JSON.stringify(value, (_key,item)=>item && typeof item==='object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item)).digest('hex')
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
export function snapshot(books, planning, context, path, target, options) {
  if (!target || !Number.isSafeInteger(target.id) || target.id < 1) throw new Error('审阅目标无效。')
  const units = [], add = (label, content, anchor, kind = 'target') => {
    for (const match of String(content).matchAll(/[\s\S]+?(?:[。！？!?](?:[”’」』])?|\n|$)/gu)) {
      if (!match[0].trim()) continue
      if (units.length >= 300) throw new Error('审阅材料超过 300 个句段，请缩小范围。')
      units.push({ id: units.length + 1, kind, label, text: match[0], anchor: { ...anchor, start: (anchor.offset ?? 0) + match.index, end: (anchor.offset ?? 0) + match.index + match[0].length } })
    }
  }
  let token, generation, revisionTarget
  if (target.section === 'decisions') {
    const item = planning.read(path, 'decisions', target.id)
    if (target.version_id !== item.version_id) throw new Error('创作方向已变化，请刷新审阅目标。')
    const selected = target.option_id ? item.options.filter(option => option.id === target.option_id) : item.options
    if (!selected.length) throw new Error('审阅方案不存在。')
    for (const option of selected) add(option.title, option.content, { section: target.section, document: target.id, version: item.options_version_id, option: option.id })
    generation = books.readState(path, db => JSON.parse(db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(item.options_version_id).metadata_json).generation)
    token = hash(item)
    revisionTarget = { slug: item.slug, title: item.title, topic: item.topic, expected_version_id: item.version_id }
  } else if (target.section === 'scenes') {
    const item = planning.read(path, 'scenes', target.id)
    if (target.token !== item.token) throw new Error('场景计划已变化，请刷新审阅目标。')
    const proposal = item.metadata.lg_plan_proposal
    add(proposal ? '待审场景计划' : '当前场景计划', proposal?.plan ?? item.plan, { section: target.section, document: target.id, token: item.token })
    for (const key of ['goal','conflict','pov','required_information','end_state']) if (item[key]) add('场景约束 · ' + key, item[key], { section: 'card', document: target.id, field: key, token: item.token }, 'constraint')
    generation = proposal?.generation ?? item.metadata.lg_plan_generation; token = item.token
    revisionTarget = { id: target.id, expected_token: item.token }
  } else if (target.section === 'manuscript') {
    const item = books.manuscript(path, target.id, target.version_id)
    if (target.token !== item.token || target.version_id !== item.selected.id || item.selected.state === 'rejected') throw new Error('正文版本或状态已变化，请刷新审阅目标。')
    const content = item.selected.content, start = target.start ?? 0, end = target.end ?? content.length
    const splits = index => index > 0 && index < content.length && /[\uD800-\uDBFF]/u.test(content[index-1]) && /[\uDC00-\uDFFF]/u.test(content[index])
    if (![start,end].every(Number.isSafeInteger) || start < 0 || end <= start || end > content.length || splits(start) || splits(end)) throw new Error('审阅选区无效。')
    add('正文选区', content.slice(start,end), { section: target.section, document: target.id, version: item.selected.id, offset: start })
    token = hash({ chapter: item.token, selected: item.selected })
    generation = item.selected.metadata?.generation
    revisionTarget = { document: target.id, version: item.selected.id, token: item.token, start, end }
  } else throw new Error('不支持此审阅对象。')
  if (!units.some(unit => unit.kind === 'target')) throw new Error('没有可审阅的内容。')
  const settings = options ?? generation?.context?.options ?? { audience: 'author' }
  if (settings.audience && settings.audience !== 'author') throw new Error('证据审阅使用作者视角。')
  const material = context.build(path, settings)
  for (const item of material.payload.items) add(item.label, item.text, { section: 'context', kind: item.kind, id: item.id }, 'context')
  const receipt = { schema: 'lg.review-sources.v1', target, options: material.receipt.options, binding: hash({ token, units, context: material.receipt }) }
  return { target, revisionTarget, units, context: material, receipt }
}
export function validateOutput(raw, source) {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u,'$1'))
  if (!Array.isArray(value?.issues) || value.issues.length > 10) throw new Error('审阅最多返回 10 个问题。')
  const rejected = [], issues = value.issues.flatMap((issue,index) => {
    try {
    if (!['info','warning','error'].includes(issue.severity) || !['约束','因果','认知','人物','节奏','表达'].includes(issue.category) ||
      !text(issue.message,2000) || !text(issue.suggestion,2000) || !Array.isArray(issue.evidence) || !issue.evidence.length || issue.evidence.length > 8) throw new Error('审阅条目格式无效。')
    const evidence = [...new Set(issue.evidence)].map(id => {
      const unit = Number.isSafeInteger(id) && source.units.find(unit => unit.id === id)
      if (!unit) throw new Error('审阅证据编号不存在。')
      return { unit: id, label: unit.label, kind: unit.kind, quote: unit.text, anchor: unit.anchor }
    })
    if (!evidence.some(item => item.kind === 'target')) throw new Error('问题必须引用被审阅内容。')
    return [{ severity: issue.severity, category: issue.category, message: issue.message, suggestion: issue.suggestion, evidence }]
    } catch (error) { rejected.push({ index: index + 1, error: error.message }); return [] }
  })
  if (!issues.length && rejected.length) throw new Error('所有审阅条目均被拒绝：' + rejected.map(item => item.error).join('；'))
  return { issues, rejected }
}
