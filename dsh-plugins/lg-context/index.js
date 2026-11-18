import { defineTool } from '@deepseek-ai/dsh-tools'
import { createContext } from './src/service.js'
export const inject = ['literaryBooks', 'literaryMemory', 'tools', 'workingDirectory']
export function apply(ctx) {
  const context = createContext(ctx.literaryBooks, ctx.literaryMemory, () => ctx.get('literaryPlanning'))
  ctx.effect(() => ctx.provide('literaryContext', context), 'lg-context: bounded inputs')
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({ path: '/api/lg/context', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json()
        let value
        if (input?.action === 'build') value = context.build(input.path, input.options)
        else if (input?.action === 'documents') value = context.documents(input.path)
        else throw new Error('未知上下文操作。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }) }
    },
  }), 'lg-context: preview API')
  })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'literary_context',
    description: 'Build bounded context for this registered book. Author context requires explicit document IDs/material switches. Character/reader options require position and character holder ID when applicable; they exclude author notes and unconfirmed cognition. This tool does not isolate other tools or chat history. Sources describe delivered fragments, not complete coverage or proof of truth.',
    parameters: { options: { type: 'json', required: true, description: 'Object: audience author|character|reader; maxBytes 1000–12000 (default4000). Author: documents:number[] (max8), facts/ideas/timeline/foreshadowing/notes/decisions booleans; optional scene ID and chapter ID (direction scope), requiring lg-planning. Character/reader: position integer; character also holder_document_id.' } },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('上下文工具需要作品会话。')
      exec.signal?.throwIfAborted()
      const path = context.forDirectory(await ctx.workingDirectory.ensure(exec.agent, exec.signal))
      // Tool callers receive only delivered material and a compact receipt, not omitted author content.
      return context.build(path, args.options)
    }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  })), 'lg-context: literary_context')
}
