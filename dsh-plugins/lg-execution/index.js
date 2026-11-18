import z from '@deepseek-ai/schemastery'
import { Ledger } from './src/ledger.js'
import { Executor } from './src/run.js'
import { NativeGuard } from './src/native.js'

export const inject = ['llm']
export const Config = z.object({
  provider: z.string().default(''), model: z.string().default(''), ledgerPath: z.string().default(''),
  budgetCny: z.number().min(0).max(10).default(0),
  inputCnyPerMillion: z.number().min(0).default(0), outputCnyPerMillion: z.number().min(0).default(0),
  maxInputBytes: z.number().step(1).min(100).max(100000).default(16000),
  maxOutputTokens: z.number().step(1).min(128).max(16384).default(4096),
  guardNative: z.boolean().default(false),
  nativeMaxCallsPerSession: z.number().step(1).min(1).max(1000).default(8),
  timeoutMs: z.number().step(1).min(1000).max(300000).default(90000),
})
export function apply(ctx, config) {
  let ledger, executor, native
  const prepaidRequests = config.guardNative ? new WeakSet() : undefined
  const get = () => {
    if (!executor) { ledger = new Ledger(config.ledgerPath); executor = new Executor(ctx.llm, ledger, config, prepaidRequests) }
    return executor
  }
  if (config.guardNative) {
    native = new NativeGuard(() => { get(); return ledger }, config, prepaidRequests)
    ctx.on('llm/stream', (options, next) => native.stream(options, next))
  }
  ctx.effect(() => ctx.provide('literaryExecution', {
    preview: input => get().preview(input), run: (id, input, signal) => get().run(id, input, signal),
    status: id => { get(); return ledger.get(id) }, totals: () => { get(); return ledger.totals() },
    cancel: id => executor?.cancel(id) ?? false,
  }), 'lg-execution: service')
  ctx.effect(() => async () => { await executor?.dispose(); await native?.dispose(); ledger?.close() }, 'lg-execution: settle and close')
}
