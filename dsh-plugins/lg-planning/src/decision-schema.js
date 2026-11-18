import { shape, text, integer, sha } from './common.js'
export const kind = 'creative_decision', schema = 'lg.creative-decision.v1'
export function topic(value) {
  shape(value, ['scope', 'document_id', 'key'])
  if (!['work', 'part', 'chapter'].includes(value.scope)) throw new Error('创作方向范围无效。')
  const id = value.document_id ?? null
  if (value.scope === 'work' ? id !== null : !Number.isSafeInteger(id) || id < 1) throw new Error('创作方向目标与范围不一致。')
  return { scope: value.scope, document_id: id, key: text(value.key, '主题', 200).trim() }
}
export function sources(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('规划来源最多 32 份。')
  const result = value.map(item => { shape(item, ['document_id', 'version_id']); return { document_id: integer(item.document_id), version_id: integer(item.version_id) } })
  if (new Set(result.map(item => item.document_id)).size !== result.length) throw new Error('每份规划来源文档只能声明一次。')
  return result
}
export function options(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('需要三个不同的创作方案。')
  const result = value.map(item => {
    shape(item, ['id', 'title', 'content'])
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(item.id)) throw new Error('方案标识无效。')
    return { id: item.id, title: text(item.title, '方案标题', 200), content: text(item.content, '方案内容') }
  })
  if (new Set(result.map(item => item.id)).size !== 3 || new Set(result.map(item => item.content.trim())).size !== 3) throw new Error('方案标识和内容不能重复。')
  return result
}
export function payload(raw) {
  if (typeof raw !== 'string' || raw.length > 65000) throw new Error('创作方向记录超过读取上限。')
  const value = shape(JSON.parse(raw), ['schema', 'operation', 'topic', 'options_version_number', 'options', 'sources', 'request', 'request_sha256', 'selection', 'selection_status'])
  if (value.schema !== schema || !['options', 'select', 'withdraw'].includes(value.operation)) throw new Error('创作方向记录格式无效。')
  topic(value.topic); options(value.options); sources(value.sources); text(value.request, '创作要求', 8000, !!value.sources.length)
  integer(value.options_version_number)
  if (value.request_sha256 !== sha(value.request)) throw new Error('创作要求摘要不匹配。')
  if (!['unselected', 'selected', 'withdrawn'].includes(value.selection_status) || (value.selection_status === 'selected') !== (value.selection !== null)) throw new Error('选择状态不一致。')
  if (value.selection) {
    const s = shape(value.selection, ['options_version_id', 'options_version_number', 'option_id', 'title', 'content', 'sources', 'request', 'request_sha256'])
    integer(s.options_version_id); integer(s.options_version_number); sources(s.sources)
    text(s.title, '选定标题', 200); text(s.content, '选定内容'); text(s.request, '创作要求', 8000, !!s.sources.length)
    if (s.request_sha256 !== sha(s.request)) throw new Error('选定要求摘要不匹配。')
  }
  if (value.operation === 'withdraw' && value.selection !== null || value.operation === 'select' && !value.selection) throw new Error('选择操作与状态不一致。')
  return value
}
export function chosen(version, value, id) {
  const option = value.options.find(option => option.id === id)
  if (!option) throw new Error('方案不属于指定的候选版本。')
  return { options_version_id: version.id, options_version_number: version.version_number, option_id: option.id,
    title: option.title, content: option.content, sources: value.sources, request: value.request, request_sha256: value.request_sha256 }
}
