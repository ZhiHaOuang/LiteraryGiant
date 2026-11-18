import { createImpact } from './src/service.js'

export const inject = ['literaryBooks']

export function apply(ctx) {
  const service = createImpact(ctx.literaryBooks, (path, kind, id) => kind === 'creative_decision'
    ? ctx.get('literaryPlanning')?.read(path, 'decisions', id)
    : ctx.get('literaryMemory')?.record(path, 'knowledge', id))
  ctx.effect(() => ctx.provide('literaryImpact', service), 'lg-impact: author diagnostics')
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lg/impact', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const input = await request.json()
          let value
          if (input.action === 'documents') value = service.documents(input.path, input.query, input.offset)
          else if (input.action === 'versions') value = service.versions(input.path, input.document, input.offset)
          else if (input.action === 'inspect') value = service.inspect(input.path, input.document, input.version, input.offset)
          else throw new Error('未知来源查询操作。')
          return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ ok: false, error: error.message }, { status: 400 })
        }
      },
    }), 'lg-impact: author API')
  })
}
