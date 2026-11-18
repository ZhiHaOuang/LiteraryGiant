import { hash } from './common.js'
export function checkGeneration(db, value, verify) {
  let generation
  if (value.action === 'decision.select') {
    const row = db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(value.after.selection.options_version_id)
    generation = JSON.parse(row.metadata_json).generation
  } else if (value.action === 'scene.approve') generation = value.before.metadata.lg_plan_proposal
    ? value.before.metadata.lg_plan_proposal.generation : value.before.metadata.lg_plan_generation
  if (generation) {
    if (!verify) throw new Error('生成来源校验服务不可用。')
    verify(generation)
  }
}
export function attachGeneration(db, result, generation) {
  if (!generation || generation.schema !== 'lg.planning-generation.v1' || JSON.stringify(generation).length > 100000) throw new Error('规划生成收据无效。')
  if (result.options_version_id) {
    const row = db.prepare('SELECT metadata_json FROM document_versions WHERE id=?').get(result.options_version_id)
    db.prepare('UPDATE document_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.metadata_json), generation }), result.options_version_id)
  } else {
    result.metadata.lg_plan_proposal.generation = generation
    db.prepare('UPDATE scene_cards SET metadata_json=? WHERE document_id=?').run(JSON.stringify(result.metadata), result.document_id)
    const { token, ...body } = result; result.token = hash(body)
  }
  return { ...result, generation }
}
export function generated(db, operation, requestHash, signature) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_planning_operations'").get()) return null
  const row = db.prepare('SELECT result FROM lg_planning_operations WHERE id=?').get(operation)
  if (!row) return null
  const result = JSON.parse(row.result), proof = result.generation
  if (!proof || proof.requestHash !== requestHash || proof.signature !== signature) throw new Error('同一规划任务不能更换输入或预览。')
  return result
}
