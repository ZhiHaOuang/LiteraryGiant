import catalog from './contracts.json' with { type: 'json' }
import { digest } from './records.js'
export const hash = value => digest(JSON.stringify(value))
export const categories = Object.keys(catalog.libraries)
export function contract(category) {
  if (!categories.includes(category)) throw new Error('未知分析卡分类。')
  const template = { portable_core: [], implementation_details: [], source_locked_details: [], fusion_hooks: [], ...catalog.INSTANCE_CARD_PROMPT_SCHEMAS[category] }
  const result = { category, ...catalog.libraries[category], template: structuredClone(template) }
  return { ...result, fingerprint: hash(result) }
}
function validate(value, template, path = 'instance_card') {
  const fail = () => { throw new Error(`分析卡字段 ${path} 类型、范围或必填项无效。`) }
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 32) fail()
    value.forEach((item, i) => validate(item, template[0] ?? '', `${path}[${i}]`))
  } else if (template && typeof template === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== Object.keys(template).length || Object.keys(value).some(key => !Object.hasOwn(template, key))) fail()
    for (const [key, shape] of Object.entries(template)) validate(value[key], shape, path + '.' + key)
  } else if (typeof template === 'number' || ['1-5', '-2 to 2', '0 to 2'].includes(template)) {
    const [min, max] = typeof template === 'number' ? [1, Number.MAX_SAFE_INTEGER] : { '1-5': [1, 5], '-2 to 2': [-2, 2], '0 to 2': [0, 2] }[template]
    if (!Number.isSafeInteger(value) || value < min || value > max) fail()
  } else if (typeof value !== 'string' || value.length > 2000 || template.includes('/') && !template.split('/').includes(value)) fail()
}
export function finalizeCard(category,card,evidence,chapter=false) {
  validate(card,contract(category).template)
  if (category === 'Worldview' && card.rule_application.event_examples.some(item => !evidence.includes(item.chunk_id))) throw new Error('世界规则示例必须引用本卡所选证据。')
  const paths = [...catalog.COMMON_QUALITY_PATHS, ...catalog.LIBRARY_QUALITY_PATHS[category]]
  const populated = paths.filter(path => { const v = path.split('.').reduce((v, key) => v?.[key], card); return Array.isArray(v) ? v.length : !!v }).length
  const quality={expected_field_count:paths.length,populated_field_count:populated,completeness:populated/paths.length}
  if (chapter) {
    quality.completeness=Number(quality.completeness.toFixed(4))
    Object.assign(quality,{directly_grounded_field_count:populated,direct_grounding_completeness:quality.completeness,needs_source_plot_lookup:populated<paths.length})
  } else quality.semantic_grounding='author_review_required'
  return {...card,schema_version:'narrative_instance_card.v1',card_type:catalog.INSTANCE_CARD_TYPES[category],grounding_mode:'llm_grounded',derivation_warnings:[],card_quality:quality}
}
export function validateAnalysis(raw, snapshot) {
  if (typeof raw !== 'string' || raw.length > 60000) throw new Error('分析卡输出超过上限。')
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u, '$1'))
  if (!value || Object.keys(value).sort().join() !== ['evidence', 'instance_card', 'summary', 'title'].join()) throw new Error('分析卡输出字段无效。')
  for (const [key, max] of [['title', 200], ['summary', 2000]]) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > max) throw new Error('分析卡标题或摘要无效。')
  const card=finalizeCard(snapshot.category,value.instance_card,Array.isArray(value.evidence)?value.evidence:[])
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 8 || value.evidence.some(id => typeof id !== 'string' || !snapshot.units.some(unit => unit.id === id))) throw new Error('分析卡必须引用有效的资料句段。')
  return {title:value.title.trim(),summary:value.summary.trim(),instance_card:card,
    evidence: [...new Set(value.evidence)].map(id => { const unit = snapshot.units.find(unit => unit.id === id); return { ...unit, quote: unit.text, text: undefined } }) }
}
export function analysisSnapshot(path, input, read) {
  const spec = contract(input.category), tokens = input.references
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 3 || new Set(tokens).size !== tokens.length || tokens.some(token => typeof token !== 'string' || token.startsWith('lgc.'))) throw new Error('请选择 1–3 条原始资料引用；分析卡不能代替原始证据。')
  const sources = tokens.map(citation => {
    const source = read(path, citation)
    let end = Math.min(source.text.length, 4000)
    if (/[\uD800-\uDBFF]/u.test(source.text[end - 1] ?? '')) end--
    return { citation, id: source.id, file: source.file, sha256: source.sha256, text: source.text.slice(0, end), truncated: source.text.length > end }
  })
  const units = sources.flatMap((source, index) => [...source.text.matchAll(/[\s\S]{1,800}?(?:[。！？!?](?:[”’」』])?|\n|$)|[\s\S]{800}/gu)].map((match, i) => ({ id: `r${index + 1}:${i + 1}`, source: index, start: match.index, end: match.index + match[0].length, text: match[0] })))
  if (!units.length) throw new Error('所选资料没有可分析片段。')
  return { category: input.category, contract: spec.fingerprint, sources, units }
}
