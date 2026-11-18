import assert from 'node:assert/strict'
import path from 'node:path'
import { getEncoding } from 'js-tiktoken'
const calls = run => run.results.map(item => item.result)
export const schemaMeasurement = tools => {
  const json = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))
  return { tokens: getEncoding('cl100k_base').encode(json).length, bytes: Buffer.byteLength(json), json }
}
export function verifyReads(run, files, projection) {
  assert.equal(run.committed.length, projection === 'candidate' ? 1 : 3)
  for (const result of calls(run)) assert.equal(result.isError, false, JSON.stringify(result))
  const values = projection === 'candidate' ? calls(run)[0].value.items.map(value => ({ path: value.path, value }))
    : run.results.map(item => ({ path: item.arguments[projection === 'official' ? 'file_path' : 'path'], value: item.result.value }))
  assert.equal(values.length, files.length)
  assert.equal(new Set(values.map(item => item.path)).size, files.length, 'each requested file appears once')
  for (const item of values) {
    const expected = files.find(file => file.path === item.path)
    assert.ok(expected, 'the returned file must be requested')
    const value = item.value
    const lines = projection === 'official' ? value.lines.map(({ number, text }) => ({ line: number, text })) : value.items.map(({ line, text }) => ({ line, text }))
    assert.deepEqual(lines, expected.expected, 'all comparators must return exactly the requested logical lines')
  }
}

export const verdict = gates => gates.length > 0 && gates.every(gate => gate.status === 'passed')
export const fullAcceptance = gates => gates.length === 5 && verdict(gates) && new Set(gates.map(gate => gate.id)).size === 5 && ['BM-01', 'BM-02', 'BM-03', 'BM-04', 'BM-05'].every(id => gates.some(gate => gate.id === id))

export function lowerBound(files, rows) {
  const sourceUtf8Bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.expected.map(line => line.text).join('\n')), 0)
  const absolutePathRangeLabelsBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.path + ':' + file.offset + '-' + file.expected.at(-1)?.line + '\n'), 0)
  return { sourceUtf8Bytes, absolutePathRangeLabelsBytes,
    labelMethod: 'Illustrative uncompressed absolute path:start-end labels; shared-base layouts can be smaller. The source-only bound needs no labels.',
    comparisons: Object.fromEntries(['baseline', 'official'].map(name => [name, { targetBytes: rows[name].outputBytes * .6,
      sourceAloneExceedsTarget: sourceUtf8Bytes > rows[name].outputBytes * .6, maximumSourceOnlySavings: 1 - sourceUtf8Bytes / rows[name].outputBytes }])) }
}
// Decode the documented representation with the platform JSON parser; do not mirror its encoder.
const decodeLine = text => JSON.parse('"' + text.replaceAll('"', '\\"') + '"')
/** Measure the actual model-visible text only after every source line is verified there too. */
export function verifyEmittedReads(run, files, projection) {
  if (projection === 'baseline') {
    const values = run.committed.map(item => JSON.parse(item.text))
    for (const file of files) { const value = values.find(value => value.path === file.path); assert.ok(value); assert.deepEqual(value.items.map(({line,text})=>({line,text})), file.expected) }
    return
  }
  if (projection === 'official') {
    for (const file of files) {
      const result = run.results.find(item => item.arguments.file_path === file.path)
      const event = run.committed.find(item => item.event.data.message.toolCallId === result.callId)
      assert.ok(event, 'official committed result identity')
      const lines = event.text.split('\n').map(line => /^(\d+): (.*)$/.exec(line)).filter(Boolean).map(match => ({line:Number(match[1]),text:match[2]}))
      assert.deepEqual(lines, file.expected)
    }
    return
  }
  const text = run.committed[0].text, base = /^\[Base: (.+)\]$/m.exec(text), groups = new Map(); let current
  for (const line of text.split('\n')) {
    const header = /^=== FILE: (.+) \(Lines .*\) ===$/.exec(line)
    if (header) { const name = header[1].startsWith('"') ? JSON.parse(header[1]) : header[1]; current = path.isAbsolute(name) ? name : path.join(JSON.parse(base[1]), name); assert.equal(groups.has(current), false); groups.set(current, []); continue }
    const row = /^(\d+)(?: \| |\|)(.*)$/.exec(line)
    if (row) { assert.ok(current); groups.get(current).push({line:Number(row[1]),text:decodeLine(row[2])}) }
  }
  assert.equal(groups.size, files.length)
  for (const file of files) assert.deepEqual(groups.get(file.path), file.expected, 'all emitted requested lines must survive before bytes are compared')
}
