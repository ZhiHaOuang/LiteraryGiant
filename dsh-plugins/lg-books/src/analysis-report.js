import { createRequire } from 'node:module'
import contracts from './analysis-contracts.json' with { type:'json' }

const validators = new Map()
function validator(card) {
  if (!validators.has(card)) {
    const schema = structuredClone(contracts.base)
    if (card) {
      const entry = schema.properties.entries.items
      entry.required.push('instance_card')
      entry.properties.instance_card = contracts.cards[card].schema
    }
    const { Ajv2020 } = createRequire(import.meta.url)('ajv/dist/2020.js')
    validators.set(card,new Ajv2020({strict:true}).compile(schema))
  }
  return validators.get(card)
}

export function verifyReport(payload, snapshot, category, canonChanged) {
  const card = payload.contract === 'lg.reference-card.v1' ? category : null
  if ((payload.contract != null && !card) || (card && payload.contract_fingerprint != null &&
    payload.contract_fingerprint !== contracts.cards[card].fingerprint)) throw new Error('分析报告契约版本无法核对。')
  const report = canonChanged ? {...payload.report,findings:[]} : payload.report
  if (!validator(card)(report)) throw new Error('分析报告或实例卡格式无效。')
  if (new Set(report.entries.map(e=>e.key)).size !== report.entries.length) throw new Error('分析条目标识重复。')
  function quotes(item) {
    return item.evidence.map(e => {
      const doc = snapshot.references.get(e.document_id)
      if (!doc || doc.version_id !== e.version_id || !doc.content.includes(e.quote)) throw new Error('分析引文与当前正文或选定方案不匹配。')
      return {...e,title:doc.title,kind:doc.kind}
    })
  }
  for (const finding of report.findings) {
    const evidence = quotes(finding)
    if (finding.kind === 'canon_conflict' && (!finding.fact_quote.trim() ||
        !snapshot.facts.some(f => f.id === finding.fact_id && f.value.includes(finding.fact_quote)) ||
        (snapshot.hasPlans && !evidence.some(q=>q.kind==='manuscript')))) throw new Error('冲突判断缺少对应的设定原文或正文证据。')
  }
  return report.entries.map(entry=>({...entry,quotes:quotes(entry)}))
}

