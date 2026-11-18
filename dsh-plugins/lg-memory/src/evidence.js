import { hash, sourceStatus } from './common.js'

export const proposalDigest = value => hash(Object.fromEntries(['category', 'fact_key', 'value', 'source_document_id', 'source_version_id'].map(key => [key, value[key]])))
export function proposalEvidence(db, proposal) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_memory_evidence'").get()) return null
  const stored = db.prepare('SELECT * FROM lg_memory_evidence WHERE proposal_id=?').get(proposal.id)
  if (!stored) return null
  const proof = JSON.parse(stored.proof), current = sourceStatus(db, proof.source.document, proof.source.version)
  return { ...proof, stale: current.status !== 'current' || current.sha256 !== proof.source.sha256 || proposalDigest(proposal) !== proof.proposalDigest }
}
export function verifyProposalEvidence(db, proposal) {
  const proof = proposalEvidence(db, proposal)
  if (proof?.stale) throw new Error('提取证据或提案内容已变化，请重新提取后审阅。')
}
