import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(value).digest('hex')
/** Prespecified sensitivity grid, including the original below-target 8-line fixture. */
export const READ_CASES = Object.freeze([
  { id: 'typescript-first-50', limit: 50, style: 'typescript', first: true, primary: true },
  { id: 'typescript-8', limit: 8, style: 'typescript' },
  { id: 'typescript-1', limit: 1, style: 'typescript' },
  { id: 'typescript-32', limit: 32, style: 'typescript' },
  { id: 'long-lines-8', limit: 8, style: 'long-lines' },
  { id: 'unicode-json-8', limit: 8, style: 'unicode-json' },
].map(Object.freeze))
export function readFixture(root, scenario) {
  const files = [13, 31, 51].map((offset, i) => {
    const lines = Array.from({ length: 70 + i * 10 }, (_, n) => scenario.style === 'typescript'
      ? `export const value${n + 1} = ${1000 + i * 100 + n};`
      : scenario.style === 'long-lines' ? `// row ${n + 1}: ${'abcdefghij'.repeat(60)}`
      : JSON.stringify({ id: n + 1, name: '路径与引号"', value: 'C:\\work\\file', active: true }))
    const text = lines.join('\n'), file = path.join(root, `module-${i}.ts`)
    fs.writeFileSync(file, text)
    return { path: file, offset: scenario.first ? 1 : offset, limit: scenario.limit, hash: hash(text), expected: lines.slice((scenario.first ? 1 : offset) - 1, (scenario.first ? 1 : offset) + scenario.limit - 1).map((text, j) => ({ line: (scenario.first ? 1 : offset) + j, text })) }
  })
  return files
}
export function fiveEdits(root) {
  const original = Array.from({ length: 80 }, (_, n) => `const value${n + 1} = ${n + 1};`).join('\n')
  const file = path.join(root, 'edit-target.ts'); fs.writeFileSync(file, original)
  const edits = [4, 16, 28, 40, 52].map(n => ({ oldText: `const value${n} = ${n};`, newText: `const value${n} = ${n * 10};` }))
  const expected = edits.reduce((text, edit) => text.replace(edit.oldText, edit.newText), original)
  return { path: file, original, expected, edits, revision: hash(original) }
}
