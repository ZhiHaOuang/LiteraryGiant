const excluded = new Set(['raw_text', 'content', 'chapter_text', 'source_locked_details'])
export function flatten(value, cap = 16000) {
  const parts = []; let size = 0
  function visit(item, depth) {
    if (size >= cap || depth > 10) return
    if (typeof item === 'string') { const text = item.slice(0, cap - size); parts.push(text); size += text.length }
    else if (Array.isArray(item)) for (const child of item.slice(0, 40)) visit(child, depth + 1)
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item).slice(0, 100)) if (!excluded.has(key)) visit(child, depth + 1)
  }
  visit(value, 0); return parts.join(' ').slice(0, cap)
}
export function terms(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('检索词需要 1–500 字。')
  const stop = new Set(['一个', '进行', '设计', '写个', '帮我', '需要', '可以', '故事', '小说']), output = []
  for (const match of query.toLowerCase().matchAll(/[a-z0-9_-]+|[\u4e00-\u9fff]+/gu)) {
    const word = match[0]
    if (word.length > 1) output.push(word)
    if (/^[\u4e00-\u9fff]{3,}$/u.test(word)) for (let i = 0; i < word.length - 1; i++) output.push(word.slice(i, i + 2))
  }
  const result = [...new Set(output)].filter(word => !stop.has(word)).slice(0, 40)
  if (!result.length) throw new Error('请使用更具体的检索词。')
  return result
}
export function excerpt(value, cap = 900) {
  const preferred = typeof value === 'object' && value ? ['pattern_name', 'generalized_pattern_name', 'archetype_family', 'summary', 'plot_function', 'driving_force', 'quality_notes']
    .filter(key => key in value).map(key => `${key}: ${flatten(value[key])}`).join('\n') : ''
  const text = (preferred || flatten(value)).replace(/\s+/gu, ' ').trim()
  return text.slice(0, cap) + (text.length > cap ? '…' : '')
}
export function sourceId(value, fallback) {
  if (value && typeof value === 'object') for (const key of ['instance_id', 'pattern_id', 'plot_id', 'book_id', 'id']) {
    if (['string', 'number'].includes(typeof value[key]) && String(value[key])) return String(value[key]).slice(0, 200)
  }
  return fallback
}
