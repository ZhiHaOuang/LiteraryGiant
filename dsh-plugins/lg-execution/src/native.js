import { randomUUID } from 'node:crypto'
import { fingerprint } from './ledger.js'
import { estimateUsage } from './cost.js'

// An opt-in observer/guard. The host owns immutable requests, tool execution and cancellation.
export class NativeGuard {
  constructor(ledger, config, prepaidRequests) { this.ledger = ledger; this.config = config; this.prepaidRequests = prepaidRequests; this.active = new Set(); this.disposed = false }
  async *stream(options, next) {
    if (this.disposed) throw new Error('原生调用预算插件已停用。')
    if (this.prepaidRequests?.delete(options)) { yield* next(); return }
    const c = this.config
    if (!c.provider || options.provider !== c.provider || options.model !== c.model ||
        ![c.inputCnyPerMillion,c.outputCnyPerMillion].every(v => Number.isFinite(v) && v > 0)) throw new Error('原生预算只允许已配置并核实价格的模型。')
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > c.maxOutputTokens) throw new Error('原生请求输出上限未确定或超过文学预算配置。')
    const request = Object.fromEntries(['provider','model','system','messages','tools','toolHistory','temperature','maxTokens','stop','reasoningEffort'].map(key => [key,options[key]]))
    const raw = JSON.stringify(request), inputBytes = Buffer.byteLength(raw)
    if (inputBytes > c.maxInputBytes) throw new Error('原生请求超过输入上限；请缩小上下文或工具集合。')
    const multimedia = value => value && typeof value === 'object' && (['image','file'].includes(value.type) || Object.values(value).some(multimedia))
    if (multimedia(options.messages)) throw new Error('原生预算当前仅支持文本，不能按文本单价估算图片或文件。')
    options.signal?.throwIfAborted()
    const session = options.sessionId ?? 'auxiliary-without-session', id = randomUUID(), ledger = this.ledger()
    const metadata = { provider:c.provider, model:c.model, maxTokens:options.maxTokens,
      inputCnyPerMillion:c.inputCnyPerMillion, outputCnyPerMillion:c.outputCnyPerMillion,
      native:{session,purpose:options.purpose??'conversation',inputBytes,toolCount:options.tools?.length??0,
        requestHash:fingerprint(request),reasoningEffort:options.reasoningEffort??null} }
    const micros = Math.ceil((inputBytes + 2048) * c.inputCnyPerMillion + options.maxTokens * c.outputCnyPerMillion)
    ledger.reserve(id, metadata, micros, Math.floor(c.budgetCny*1e6), {session,maxCalls:c.nativeMaxCallsPerSession})
    let settled; const pending = new Promise(resolve => { settled = resolve }); this.active.add(pending)
    let usage = null, finish = null, complete = false, toolCalls = 0
    const start = performance.now()
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') toolCalls++
        yield chunk
      }
      complete = true
    } finally {
      try {
        const status = options.signal?.aborted || finish?.kind === 'aborted' ? 'cancelled'
          : complete && ['stop','tool-calls'].includes(finish?.kind) ? 'succeeded' : 'failed'
        ledger.finish(id,status,{usage,estimatedCny:estimateUsage(usage,c),elapsedMs:Math.round(performance.now()-start),
          finish:finish?.kind??null,toolCalls,complete})
      } finally { this.active.delete(pending); settled() }
    }
  }
  async dispose() { this.disposed = true; await Promise.allSettled([...this.active]) }
}
