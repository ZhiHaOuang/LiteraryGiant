import { hash, integer, row, text, choice, sourceStatus, decorated } from './common.js'
import { planFact, applyFact } from './facts.js'
import { proposalDigest, proposalEvidence } from './evidence.js'

export function extractionSource(db, id) {
  const doc = row(db, 'documents', id), version = row(db, 'document_versions', doc.active_version_id)
  if (!['chapter', 'scene'].includes(doc.kind) || sourceStatus(db, doc.id, version.id).status !== 'current') throw new Error('只能从当前已采纳的章节或场景提取记忆。')
  if (!version.content.trim() || version.content.length > 400000) throw new Error('正文为空或超过读取上限。')
  const source = { document: doc.id, version: version.id, title: doc.title, text: version.content, sha256: hash(version.content) }
  return { ...source, token: hash(source) }
}
export function extractionSnapshot(db, target) {
  const full = extractionSource(db, target?.document)
  if (target.version !== full.version || target.token !== full.token) throw new Error('提取来源版本已变化，请重新选择正文。')
  const start = integer(target.start, 0, full.text.length), end = integer(target.end, start + 1, full.text.length)
  const split = index => index > 0 && /[\uD800-\uDBFF]/u.test(full.text[index - 1]) && /[\uDC00-\uDFFF]/u.test(full.text[index] ?? '')
  if (end - start > 12000 || split(start) || split(end)) throw new Error('请选择最多 12000 字且边界完整的正文。')
  const selected = full.text.slice(start, end)
  const units = [...selected.matchAll(/[\s\S]+?(?:[。！？!?](?:[”’」』])?|\n|$)/gu)].map((match, index) => ({ id: index + 1, start: start + match.index, end: start + match.index + match[0].length, text: match[0] }))
  return { target: { ...target }, source: { document: full.document, version: full.version, title: full.title, sha256: full.sha256 }, units }
}
export function validateExtraction(raw, snapshot) {
  const value = JSON.parse(raw.trim())
  if (!value || Object.keys(value).some(key => key !== 'facts') || !Array.isArray(value.facts) || value.facts.length > 8) throw new Error('记忆提取必须返回 facts 数组，最多 8 项。')
  const keys = new Set()
  return value.facts.map(item => {
    if (!item || Object.keys(item).some(key => !['category', 'key', 'value', 'evidence'].includes(key))) throw new Error('提取条目包含未知字段。')
    const category = choice(item.category, ['人物', '关系', '物品', '地点', '规则', '事件']), key = text(item.key, '事实键', 200), content = text(item.value, '事实内容', 1200)
    if (keys.has(category + '\0' + key)) throw new Error('同一次提取不能重复分类与事实键。')
    keys.add(category + '\0' + key)
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 4 || item.evidence.some(id => !Number.isSafeInteger(id) || !snapshot.units.some(unit => unit.id === id))) throw new Error('事实提案缺少有效的原文证据编号。')
    const evidence = [...new Set(item.evidence)].map(id => { const unit = snapshot.units.find(unit => unit.id === id); return { start: unit.start, end: unit.end, quote: unit.text } })
    return { category, key, value: content, evidence }
  })
}
export function extractionService(books, receipt) {
  const signatureOf = (request, signature) => hash({ extraction: request, signature })
  return {
    extractionSource: (path, id) => books.readState(path, db => extractionSource(db, id)),
    extractionSnapshot: (path, target) => books.readState(path, db => extractionSnapshot(db, target)),
    validateExtraction,
    extracted(path, operation, request, signature) {
      return books.readState(path, db => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_memory_operations'").get()) return null
        const previous = db.prepare('SELECT * FROM lg_memory_operations WHERE id=?').get(operation)
        if (!previous) return null
        if (previous.signature !== signatureOf(request, signature)) throw new Error('记忆提取操作的输入发生变化。')
        const result = JSON.parse(previous.result)
        return { ...result, proposals: result.proposals.map(item => {
          const current = row(db, 'fact_proposals', item.id)
          return { ...decorated(db, current), extraction: proposalEvidence(db, current) }
        }) }
      })
    },
    saveExtraction(path, operation, request, signature, snapshot, raw) {
      return books.changeState(path, db => receipt(db, operation, signatureOf(request, signature), () => {
        const current = extractionSnapshot(db, snapshot.target)
        if (hash(current) !== hash(snapshot)) throw new Error('提取期间正文或证据发生变化。')
        const facts = validateExtraction(raw, current)
        db.exec('CREATE TABLE IF NOT EXISTS lg_memory_evidence (proposal_id INTEGER PRIMARY KEY REFERENCES fact_proposals(id), proof TEXT NOT NULL)')
        const proposals = facts.map(item => {
          const proposal = applyFact(db, planFact(db, { action: 'fact.propose', category: item.category, key: item.key, value: item.value,
            source_document_id: current.source.document, source_version_id: current.source.version, rationale: '记忆专家从已采纳正文提取；证据只定位来源，含义仍需作者核对。' }))
          const proof = { run: operation, source: current.source, evidence: item.evidence, proposalDigest: proposalDigest(proposal) }
          db.prepare('INSERT INTO lg_memory_evidence VALUES (?,?)').run(proposal.id, JSON.stringify(proof))
          return { ...proposal, extraction: { ...proof, stale: false } }
        })
        return { run: operation, proposals, source: current.source }
      }))
    },
  }
}
