import { realpathSync } from 'node:fs'
import { policy, hash, assemble } from './policy.js'
import { select } from './select.js'
export function createContext(books, memory, planning = () => undefined) {
  const build = (path, input) => {
    // Admission must also occur when no documents or memories are selected.
    books.readState(path, () => null)
    const options = policy(input), selected = select(books, memory, path, options, planning())
    const result = assemble(options, selected.items, selected.warnings)
    const receipt = { schema: 'lg.context-receipt.v1', book: hash(realpathSync(path)), options,
      payloadHash: hash(result.payload), sources: result.sources }
    return { ...result, receipt, fingerprint: hash(receipt) }
  }
  return {
    build,
    verify(path, receipt) {
      if (!receipt || receipt.schema !== 'lg.context-receipt.v1' || JSON.stringify(receipt).length > 100000) throw new Error('上下文来源收据无效。')
      const current = build(path, receipt.options)
      if (hash(current.receipt) !== hash(receipt)) throw new Error('文学上下文来源或选择结果已变化，请重新预览／生成。')
      return true
    },
    verifyPlanSources(path, receipt, sceneId) {
      if (!receipt || receipt.schema !== 'lg.context-receipt.v1' || receipt.book !== hash(realpathSync(path)) || !Array.isArray(receipt.sources) || JSON.stringify(receipt).length > 100000) throw new Error('计划上下文来源收据无效。')
      books.readState(path, () => null)
      const current = select(books, memory, path, policy(receipt.options), planning()).items
      for (const source of receipt.sources) {
        // Approval replaces this scene's prior plan; its current approved card is checked by lg-planning.
        if (source.kind === 'scene' && source.id === sceneId) continue
        const item = current.find(item => item.kind === source.kind && item.id === source.id)
        if (!item || hash(item.identity) !== hash(source.identity) || item.sourceHash !== source.sourceHash) throw new Error('已批准计划使用的外部材料已变化，请复核计划。')
      }
      return true
    },
    documents(path) { return memory.documents(path).filter(item => !['creative_decision', 'narrative_knowledge'].includes(item.kind)) },
    forDirectory: path => memory.forDirectory(path),
  }
}
