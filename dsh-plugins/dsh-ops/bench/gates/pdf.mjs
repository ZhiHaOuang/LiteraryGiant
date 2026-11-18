import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { boot } from './host.mjs'
import { publicToolName } from '../../lib/policy.js'
import { capability } from '../../lib/capabilities/registry.js'
export async function bm04(options) {
  if (!capability('read_pdf')) return { id: 'BM-04', status: 'blocked', reason: 'The integrated catalogue does not yet contain a reviewed PDF reader; stat lifecycle tests are not PDF acceptance.' }
  const { textPdf, show } = await import('../../test/lib/pdf-fixture.mjs')
  const root = path.join(options.temporary, 'pdf-discovery'); fs.mkdirSync(root)
  const file = path.join(root, 'one-page.pdf'); fs.writeFileSync(file, textPdf([show('BM04 PDF text')], { deflate: true }))
  const host = await boot({ ...options, root })
  try {
    const owner = await host.agent(), sibling = await host.agent()
    const visible = request => request.tools.some(tool => tool.name === publicToolName('read_pdf'))
    const run = await host.run(owner, [request => {
      assert.equal(visible(request), false, 'no PDF schema before activation')
      return [{ name: publicToolName('discover_tools'), args: { query: 'select:' + publicToolName('read_pdf') } }]
    }, request => {
      assert.equal(visible(request), true, 'PDF must appear in the immediately following provider request')
      assert.equal(host.ctx.get('tools').get(publicToolName('read_pdf'), sibling), undefined)
      return [{ name: publicToolName('read_pdf'), args: { path: file, offset: 1, limit: 1 } }]
    }, []])
    const pdf = run.results.find(item => item.name === publicToolName('read_pdf')).result
    assert.equal(pdf.isError, false); assert.match(JSON.stringify(pdf.value.items), /BM04 PDF text/)
    return { id: 'BM-04', status: 'passed', initialPdfSchemas: 0, activationRequest: 1, firstAvailableRequest: 2, run }
  } finally { await host.close() }
}
