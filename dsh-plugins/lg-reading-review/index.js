import { reviewNotes } from './src/review-notes.js'

export const inject = ['literaryBooks']
export function apply(ctx) {
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lg/reading-notes', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const value = reviewNotes(ctx.literaryBooks, await request.json())
          return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ ok: false, error: error.message }, { status: 400 })
        }
      },
    }), 'lg-reading-review: reading notes')
  })
}
