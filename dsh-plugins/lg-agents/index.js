import z from '@deepseek-ai/schemastery'
import { createAgents } from './src/service.js'
export const inject = ['literaryBooks', 'literaryExecution']
export const Config = z.object({ roles: z.array(z.object({ id: z.string().required(),
  enabled: z.boolean().default(true), instructions: z.string().default('') })).default([]).volatile() })
export function apply(ctx, config) {
  const roleConfig = { get roles() { return config.roles.get() } }
  const agents = createAgents(ctx.literaryBooks, ctx.literaryExecution, roleConfig, () => ctx.get('literaryLibrary'), () => ctx.get('literaryContext'), () => ctx.get('literaryPlanning'), () => ctx.get('literaryReview'), () => ctx.get('literaryMemory'), () => ctx.get('literaryAuthor'), () => ctx.get('literaryMethods'))
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'lg-agents: cancel detached tasks')
  ctx.effect(() => ctx.provide('literaryAgents', agents), 'lg-agents: specialists')
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({ path: '/api/lg/agents', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json()
        if (!input || typeof input !== 'object') throw new Error('请求格式错误。')
        let value
        if (input.action === 'roles') value = agents.roles()
        else if(input.action==='analysis-status')value=agents.analysisStatus(input.path,input.target)
        else if (input.action === 'methods') value = agents.methods(input.task)
        else if (input.action === 'preview') value = agents.preview(input)
        else if (input.action === 'run') value = await agents.run(input, AbortSignal.any([request.signal, lifetime.signal]))
        else if (input.action === 'status') value = agents.status(input.operation)
        else if (input.action === 'cancel') value = agents.cancel(input.operation)
        else throw new Error('未知文学任务。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }) }
    },
  }), 'lg-agents: author task API')
  })
}
