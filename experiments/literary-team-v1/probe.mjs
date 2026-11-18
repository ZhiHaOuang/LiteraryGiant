import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { reserve, settle } from './budget.mjs'
import { response, chunks } from './scripted.mjs'
export const inject = ['llm', 'tools']
export function apply(ctx) {
  const log = value => appendFileSync(join(process.env.LG_LAB_RUN, 'trace.jsonl'), JSON.stringify(value) + '\n')
  ctx.on('llm/stream', async function* (options, next) {
    const input = Object.fromEntries(['sessionId', 'purpose', 'provider', 'model', 'reasoningEffort', 'system', 'messages', 'tools'].map(k => [k, options[k]]))
    if (options.provider !== 'lg-validation' || options.model !== 'glm-4.5-air') throw Error('Unapproved model route')
    const allowed = ['agent_teams_send_message', 'agent_teams_create', 'agent_teams_status', 'agent_teams_claim_task', 'agent_teams_update_task', 'lg_read_chapter', 'lg_read_analysis']
    if ((options.tools ?? []).some(t => !allowed.includes(t.name))) throw Error('Unexpected tool exposure')
    for (const tool of options.tools ?? []) {
      if (tool.name.startsWith('lg_') && (tool.parameters?.type !== 'object' || !tool.parameters.properties)) throw Error('Literary tool must emit standard JSON Schema')
      if (tool.name === 'lg_read_chapter' && !tool.parameters.required?.includes('chapter')) throw Error('Chapter argument must be required in model schema')
    }
    const dry = process.env.LG_LAB_DRY === '1'
    const id = dry ? 'scripted' : reserve(process.env.LG_LAB_LEDGER, { sessionId: options.sessionId, provider: options.provider, model: options.model, purpose: options.purpose ?? 'agent-step' })
    log({ event: 'request', id, input })
    const started = performance.now(); let usage, finish, text = '', failure
    try {
      for await (const chunk of (dry ? chunks(response(options)) : next())) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        if (chunk.type === 'text-delta') text += chunk.text
        yield chunk
      }
    } catch (error) { failure = error.name; throw error }
    finally { if (!dry) settle(process.env.LG_LAB_LEDGER, id, { usage, finish, failure, elapsedMs: Math.round(performance.now() - started) }); log({ event: 'response', id, sessionId: options.sessionId, text, finish }) }
  })
  ctx.on('tools/result', (exec, result) => log({ event: 'tool-result', sessionId: exec.agent?.id, name: exec.name, args: exec.arguments, isError: result.isError, content: result.content }))
  ctx.on('agent/status', ({ agent, status }) => log({ event: 'status', sessionId: agent.id, status }))
}
