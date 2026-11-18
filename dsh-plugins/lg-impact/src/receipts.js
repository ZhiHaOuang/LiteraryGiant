import { createHash } from 'node:crypto'

export const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0

// An options list can mention a document that did not fit the model's input budget.
export function contextReferences(receipt, book, add, stats) {
  if (!receipt) return
  if (receipt.schema !== 'lg.context-receipt.v1' || receipt.book !== book ||
      !digest(receipt.payloadHash) || !Array.isArray(receipt.sources)) {
    stats.invalid++
    return
  }
  for (const source of receipt.sources) {
    if (!digest(source?.sourceHash) || !digest(source?.excerptHash)) {
      stats.invalid++
      continue
    }
    if (source.kind === 'document') add(source.id, source.identity?.version, '模型上下文')
    if (source.kind === 'decision') add(source.id, source.identity?.options_version_id, '选定方向')
    if (source.kind === 'cognition') add(source.id, source.identity?.proposal, '认知提案输入')
    if (source.kind === 'scene') add(source.id, null, '场景卡输入')
  }
}

export function legacyReferences(metadata, output, add, stats) {
  const receipt = metadata.generation_sources
  if (!receipt) return
  if (receipt.schema !== 'lg.generation-sources.v1' || !['partial', 'unknown'].includes(receipt.coverage) ||
      typeof receipt.run_id !== 'string' || typeof receipt.mode !== 'string' ||
      typeof output !== 'string' || sha(output) !== metadata.generation_output_sha256 ||
      !Array.isArray(receipt.observations) || !receipt.observations.every(item =>
        typeof item?.tool === 'string' && digest(item.payload_sha256) && ['partial','unknown'].includes(item.coverage) &&
        Array.isArray(item.refs) && item.refs.every(ref => ref && typeof ref === 'object' && !Array.isArray(ref)))) {
    stats.invalid++
    return
  }
  for (const observation of receipt.observations) {
    for (const ref of observation.refs) {
      if (ref.kind === 'document' && ref.exposure === 'index') { stats.indexOnly++; continue }
      if (ref.kind === 'document' && ['content','excerpt'].includes(ref.exposure) &&
          ['read_document','render_story_context','story_source_document'].includes(observation.tool) &&
          positive(ref.version_id)) {
        add(ref.document_id, ref.version_id, '旧生成收据 · ' + observation.tool)
      } else {
        stats.unsupported++
      }
    }
  }
}
