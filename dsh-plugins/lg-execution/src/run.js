import { estimateUsage } from './cost.js'
/** One bounded text request; provider credentials remain in DSH's adapter. */
export class Executor {
  constructor(llm, ledger, config, prepaidRequests) {
    this.prepaidRequests = prepaidRequests
    this.llm = llm; this.ledger = ledger; this.config = config; this.active = new Map(); this.pending = new Set(); this.disposed = false
  }
  preview(input) {
    const c = this.config
    if (!c.provider || !c.model || ![c.inputCnyPerMillion, c.outputCnyPerMillion].every(x => Number.isFinite(x) && x > 0)) {
      throw new Error('先配置模型和已核实的计费单价。')
    }
    if (typeof input.system !== 'string' || typeof input.input !== 'string') throw new Error('模型输入格式无效。')
    const bytes = Buffer.byteLength(input.system + input.input)
    if (bytes > c.maxInputBytes) throw new Error('任务输入超过上限，请缩小范围。')
    const micros = Math.ceil((bytes + 2048) * c.inputCnyPerMillion + c.maxOutputTokens * c.outputCnyPerMillion)
    return { request: { system: input.system, input: input.input, scope: input.scope ?? '', provider: c.provider, model: c.model,
      maxTokens: c.maxOutputTokens, inputCnyPerMillion: c.inputCnyPerMillion, outputCnyPerMillion: c.outputCnyPerMillion }, micros, inputBytes: bytes }
  }
  run(id, input, externalSignal) {
    if (this.disposed) return Promise.reject(new Error('执行插件已停用。'))
    const promise = this.execute(id, input, externalSignal)
    this.pending.add(promise)
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
    return promise
  }
  async execute(id, input, externalSignal) {
    const plan = this.preview(input), c = this.config
    const reservation = this.ledger.reserve(id, plan.request, plan.micros, Math.floor(c.budgetCny * 1e6))
    if (reservation.existing) return reservation.existing
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), c.timeoutMs)
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
    this.active.set(id, controller)
    const start = performance.now(), blocks = new Map()
    let usage = null, finish = null, seenBytes = 0
    try {
      signal.throwIfAborted()
      const call = await this.llm.prepareCall({ provider: c.provider, model: c.model, maxTokens: c.maxOutputTokens }, signal,
        (controls, model) => ({ ...controls, ...(model.reasoning?.efforts.some(e => e.id === 'off') ? { reasoningEffort: 'off' } : {}) }))
      const request = { ...call.config, system: input.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input.input }] }], purpose: 'literary-task', signal }
      this.prepaidRequests?.add(request)
      for await (const chunk of call.stream(request)) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          seenBytes += Buffer.byteLength(chunk.text)
          if (seenBytes > 2_000_000) throw new Error('输出超过本地处理上限。')
        }
        if (chunk.type === 'block-end') {
          if (chunk.block.type === 'tool-call') throw new Error('文学短任务不执行工具调用。')
          if (chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text)
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
      }
      signal.throwIfAborted()
      if (finish?.kind !== 'stop') throw new Error('模型未完整结束；不采用截断或失败结果。')
      const text = [...blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n')
      if (!text.trim()) throw new Error('模型没有返回正文。')
      const estimatedCny = estimateUsage(usage, c)
      return this.ledger.finish(id, 'succeeded', { text, usage, estimatedCny, elapsedMs: Math.round(performance.now() - start) })
    } catch (error) {
      // Never persist raw adapter errors: upstream failures may contain request headers.
      return this.ledger.finish(id, signal.aborted ? 'cancelled' : 'failed', {
        error: signal.aborted ? '任务取消或超时。' : '模型调用未完整成功；没有自动重试。',
        code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'CALL_FAILED',
        finish: finish?.kind ?? null, usage, elapsedMs: Math.round(performance.now() - start) })
    } finally { clearTimeout(timer); this.active.delete(id) }
  }
  cancel(id) { const controller = this.active.get(id); controller?.abort(); return !!controller }
  async dispose() {
    this.disposed = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.pending])
  }
}
