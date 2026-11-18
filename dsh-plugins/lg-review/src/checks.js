import { hash } from './targets.js'

function rulesFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['minHan','maxHan','required','forbidden','ending'].includes(key))) throw new Error('正文检查规则无效。')
  const rules = {}
  for (const key of ['minHan','maxHan']) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 400000) throw new Error('汉字数范围须为 0–400000 的整数。')
    rules[key] = input[key]
  }
  if (rules.minHan > rules.maxHan) throw new Error('最少汉字数不能大于最多汉字数。')
  for (const key of ['required','forbidden']) {
    const terms = input[key] ?? []
    if (!Array.isArray(terms) || terms.length > 32 || terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 100 || !term.isWellFormed()) || new Set(terms).size !== terms.length) throw new Error('每组词表最多 32 个不同的非空词，每词最多 100 字符。')
    rules[key] = terms
  }
  if (rules.required.some(term => rules.forbidden.includes(term))) throw new Error('同一词不能同时必含和禁用。')
  if (input.ending !== undefined) {
    if (typeof input.ending !== 'string' || !input.ending.trim() || input.ending.length > 500 || !input.ending.isWellFormed()) throw new Error('精确结尾须为 1–500 字符的非空文本。')
    rules.ending = input.ending
  }
  return rules
}
function matches(text, term) {
  const positions = []; let count = 0, at = text.indexOf(term)
  while (at !== -1) {
    count++
    if (positions.length < 20) positions.push({start:at,end:at+term.length})
    at = text.indexOf(term, at + 1)
  }
  return {count,positions,truncated:count>positions.length}
}
export function checkManuscript(books, path, target, input) {
  if (!target || !Number.isSafeInteger(target.document) || !Number.isSafeInteger(target.version) || typeof target.token !== 'string') throw new Error('请选择正文文档、版本及当前快照。')
  const rules = rulesFor(input), body = books.manuscript(path,target.document,target.version)
  if (body.token !== target.token) throw new Error('章节快照已变化，请刷新后检查。')
  const text = body.selected.content
  const metrics = {han:(text.match(/\p{Script=Han}/gu)??[]).length,characters:[...text].length,paragraphs:text.split(/\r\n|[\n\r\u2028\u2029]/u).filter(line=>line.trim()).length}
  const checks = []
  if (rules.minHan !== undefined || rules.maxHan !== undefined) checks.push({kind:'han-range',passed:metrics.han >= (rules.minHan??0) && metrics.han <= (rules.maxHan??400000),actual:metrics.han,min:rules.minHan??0,max:rules.maxHan??400000})
  for (const key of ['required','forbidden']) for (const term of rules[key]) {
    const found = matches(text,term)
    checks.push({kind:key,term,passed:key==='required'?found.count>0:found.count===0,...found})
  }
  if (rules.ending !== undefined) checks.push({kind:'ending',term:rules.ending,passed:text.endsWith(rules.ending),actual:text.slice(-rules.ending.length)})
  return {schema:'lg.manuscript-checks.v1',target:{document:body.document.id,version:body.selected.id,token:body.token,contentHash:hash(text)},rules,metrics,checks,passed:checks.length?checks.every(check=>check.passed):null}
}
