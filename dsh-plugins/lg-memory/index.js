import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMemory } from './src/service.js'

export const inject = ['literaryBooks', 'tools', 'workingDirectory']
export function apply(ctx) {
  const memory = createMemory(ctx.literaryBooks)
  ctx.effect(() => ctx.provide('literaryMemory', memory), 'lg-memory: story state')
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({ path: '/api/lg/memory', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json()
        if (!input || typeof input !== 'object') throw new Error('请求格式错误。')
        let value
        if (input.action === 'list') value = memory.list(input.path, input.section, input)
        else if (input.action === 'record') value = memory.record(input.path, input.section, input.id)
        else if (input.action === 'extraction-source') value = memory.extractionSource(input.path, input.document)
        else if (input.action === 'documents') value = memory.documents(input.path)
        else if (input.action === 'history') value = memory.history(input.path, input.id, input)
        else if (input.action === 'view') value = memory.view(input.path, input)
        else if (input.action === 'preview') value = memory.preview(input.path, input.change)
        else if (input.action === 'apply') value = memory.apply(input.path, input.change, input.token, input.operation)
        else throw new Error('未知记忆操作。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }) }
    },
  }), 'lg-memory: author API')
  })
  const bookFor = async exec => {
    if (!exec.agent) throw new Error('记忆工具需要作品会话。')
    exec.signal?.throwIfAborted()
    return memory.forDirectory(await ctx.workingDirectory.ensure(exec.agent, exec.signal))
  }
  for (const tool of [
    { name: 'literary_memory', description: 'Read story memory for the registered book containing this session directory. World facts, character cognition and reader knowledge are distinct. Character/reader views require an explicit author-defined position and omit unconfirmed or stale-source statements. Use author mode to inspect a record and its latest version before proposing revisions; it includes provisional and author-only material and must not be treated as character/reader knowledge. These views do not isolate other tools/history and may have incomplete coverage.',
      parameters: { audience: { type: 'string', enum: ['world', 'character', 'reader', 'author'], required: true },
        section: { type: 'string', enum: ['facts', 'proposals', 'timeline', 'foreshadowing', 'knowledge'], description: 'Author inspection section; default knowledge.' },
        id: { type: 'integer', description: 'Author mode: exact record ID; omit for a paginated list.' }, offset: { type: 'integer', description: 'Author list offset, default 0.' },
        query: { type: 'string', description: 'Author list keyword filter; cognition searches title/slug.' }, category: { type: 'string', description: 'Fact/proposal category filter.' },
        state: { type: 'string', description: 'Fact/timeline/foreshadow state filter.' }, status: { type: 'string', description: 'Proposal status; default proposed, empty string for all.' }, tags: { type: 'array', items: { type: 'string' }, description: 'Require each exact tag.' },
        position: { type: 'integer', description: 'Required for character/reader: story position for character, reading position for reader.' },
        holder_document_id: { type: 'integer', description: 'Required character document ID for character cognition only.' }, limit: { type: 'integer' } },
      async execute(args, exec) {
        const path = await bookFor(exec)
        if (args.audience === 'author') return args.id === undefined ? memory.list(path, args.section ?? 'knowledge', args) : memory.record(path, args.section ?? 'knowledge', args.id)
        return args.audience === 'world' ? memory.world(path, args.limit) : memory.view(path, args)
      } },
    { name: 'literary_remember', description: 'Save a provisional memory proposal. Never confirms world facts, cognition, timeline or foreshadowing. Author review is required. For fact.propose provide category,key,value,rationale and optional exact source_document_id/source_version_id. For knowledge.propose provide slug,title,expected_version_id (0 for new),topic {audience,holder_document_id,key,from_position},statement {content,stance,until_position,sources:[{document_id,version_id}]},rationale. Read current records before revisions; retry the same operation ID to avoid duplicate proposals.',
      parameters: { operation: { type: 'string', required: true, description: 'Unique 16–80 character request ID; keep unchanged on retry.' },
        proposal: { type: 'json', required: true, description: 'Object with action fact.propose or knowledge.propose and its fields.' } },
      async execute(args, exec) { return memory.propose(await bookFor(exec), args.proposal, args.operation) } },
  ]) ctx.effect(() => ctx.tools.register(defineTool({ ...tool, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } })), `lg-memory: ${tool.name}`)
}
