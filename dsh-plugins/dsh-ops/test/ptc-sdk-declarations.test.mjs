/** The shipped PTC declarations must describe the loader as its own receipt, not a file operation. */
import fs from 'node:fs'
import path from 'node:path'
import { CAPABILITIES } from '../lib/capabilities/registry.js'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const EXPECTED_MEMBERS = CAPABILITIES.filter(entry => 'parameters' in entry && entry.presentations.includes('ptc')).length

const text = fs.readFileSync(path.join(PACKAGE_ROOT, 'lib/ptc/sdk.d.ts'), 'utf8')
const member = (name) => {
  const start = text.indexOf(JSON.stringify(name) + ': (args:')
  assert.notEqual(start, -1, name + ' is missing from the generated declarations')
  const rest = text.slice(start + 1)
  const end = rest.search(/\n  "/u)
  return end === -1 ? rest : rest.slice(0, end)
}

await test('the SDK loader declaration is its selection receipt, not a generic file receipt', () => {
  const loader = member('ops_load_sdk')
  assert.match(loader, /nextTurn: true/)
  assert.match(loader, /tools: string\[\]/)
  assert.doesNotMatch(loader, /items\?:/, 'the loader does not return file-operation rows')
  assert.doesNotMatch(loader, /reference\?:/, 'the loader does not return storage references')
})

await test('every generated member is a public ops_ name', () => {
  const names = [...text.matchAll(/^  "(ops_[a-z_]+)": \(args:/gmu)].map(match => match[1])
  assert.equal(names.length, EXPECTED_MEMBERS, 'every PTC-presented capability is declared exactly once')
  assert.equal(new Set(names).size, names.length, 'no member may be declared twice')
})
report('ptc-sdk-declarations')
