import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPlanning } from './src/service.js'
export const inject = ['literaryBooks', 'tools', 'workingDirectory']
export function apply(ctx) {
  const planning = createPlanning(ctx.literaryBooks, (path, proof, approvedScene) => {
    if (proof.schema !== 'lg.planning-generation.v1') throw new Error('规划生成收据格式未知。')
    if (proof.context || proof.feedback?.context) {
      const context = ctx.get('literaryContext')
      if (!context) throw new Error('请启用 lg-context 校验规划来源。')
      for (const receipt of [proof.context, proof.feedback?.context].filter(Boolean)) {
        if (approvedScene && proof.task === 'scene-plan') context.verifyPlanSources(path, receipt, approvedScene)
        else context.verify(path, receipt)
      }
    }
    if (proof.references?.length) {
      const library = ctx.get('literaryLibrary')
      if (!library) throw new Error('请启用 lg-library 校验规划参考资料。')
      for (const source of proof.references) if (library.read(path, source.citation).sha256 !== source.sha256) throw new Error('规划参考资料已变化。')
    }
  })
  ctx.effect(() => ctx.provide('literaryPlanning', planning), 'lg-planning: plans and decisions')
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({ path: '/api/lg/planning', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json(); let value
        if (input?.action === 'preview') value = planning.preview(input.path, input.change)
        else if (input?.action === 'apply') value = planning.apply(input.path, input.change, input.token, input.operation)
        else if (input?.action === 'documents') value = planning.documents(input.path)
        else if (input?.action === 'list') value = planning.list(input.path, input.section, input)
        else if (input?.action === 'read') value = planning.read(input.path, input.section, input.id)
        else if (input?.action === 'history') value = planning.history(input.path, input.id, input.offset)
        else if (input?.action === 'context') value = planning.context(input.path, input)
        else if (input?.action === 'window') value = planning.window(input.path, input)
        else throw new Error('未知规划操作。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }) }
    },
  }), 'lg-planning: author API')
  })
  const bookFor = async exec => {
    if (!exec.agent) throw new Error('规划工具需要作品会话。')
    exec.signal?.throwIfAborted()
    return planning.forDirectory(await ctx.workingDirectory.ensure(exec.agent, exec.signal))
  }
  for (const tool of [
    { name: 'literary_plan', description: 'Inspect author-level creative decisions, scene cards, structure, history or a bounded same-volume chapter window. These plans are not world facts or character knowledge. Read exact current heads/tokens before proposing changes. Provisional options never replace an author selection; stale selections need author reconciliation.',
      parameters: { action: { type: 'string', enum: ['list', 'read', 'history', 'context', 'window'], required: true },
        section: { type: 'string', enum: ['decisions', 'scenes', 'structure'] }, id: { type: 'integer' }, offset: { type: 'integer' },
        limit: { type: 'integer' }, chapter_id: { type: 'integer' }, horizon: { type: 'integer' } },
      async execute(args, exec) {
        const path = await bookFor(exec)
        if (args.action === 'list') return planning.list(path, args.section, args)
        if (args.action === 'read') return planning.read(path, args.section, args.id)
        if (args.action === 'history') return planning.history(path, args.id, args.offset)
        if (args.action === 'context') return planning.context(path, args)
        if (args.action === 'window') return planning.window(path, args)
        throw new Error('未知规划查询。')
      } },
    { name: 'literary_propose_plan', description: 'Save provisional planning only. decision.options: slug,title,expected_version_id (0 new),topic {scope:work|part|chapter,document_id:null|id,key}, exactly three options [{id,title,content}], sources [{document_id,version_id}],request. Scoped target must be a source. scene.plan: id,expected_token,plan; stores pending plan without replacing approved plan. Author selects/withdraws/approves in UI. Keep operation ID unchanged for safe retry.',
      parameters: { operation: { type: 'string', required: true }, change: { type: 'json', required: true } },
      async execute(args, exec) { return planning.propose(await bookFor(exec), args.change, args.operation) } },
  ]) ctx.effect(() => ctx.tools.register(defineTool({ ...tool, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] } })), `lg-planning: ${tool.name}`)
}
