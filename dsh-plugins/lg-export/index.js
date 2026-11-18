import { collect } from './src/content.js'
import { encode } from './src/encode.js'
import { formats, targets } from './src/options.js'

export const inject = ['literaryBooks']

export function exportBook(books, { path, target, format, includeDrafts = false }) {
  if (typeof target !== 'string' || typeof format !== 'string' || !Object.hasOwn(targets, target) || !Object.hasOwn(formats, format) || typeof includeDrafts !== 'boolean') {
    throw new Error('导出类型、格式或草稿选项无效。')
  }
  const book = books.list().find(item => item.path === path && !item.error)
  if (!book) throw new Error('请选择已登记的作品。')
  const blocks = books.readState(path, db => {
    if (db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get()?.value !== book.id) {
      throw new Error('作品已变化，请重新选择。')
    }
    return collect(db, book.name, target, includeDrafts)
  })
  return encode(blocks, format)
}

export function apply(ctx) {
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lg/export', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const input = await request.json()
          const bytes = exportBook(ctx.literaryBooks, input)
          return new Response(bytes, { headers: { 'content-type': formats[input.format], 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ error: error.message }, { status: 400, headers: { 'cache-control': 'no-store' } })
        }
      },
    }), 'lg-export: author downloads')
  })
}
