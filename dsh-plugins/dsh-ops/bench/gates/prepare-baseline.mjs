/** Write an exact committed baseline tree without checkout newline conversion or tar dependencies. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BASELINE_REVISION } from './provenance.mjs'
const repository = fileURLToPath(new URL('../../', import.meta.url))
export function prepareBaseline(destination) {
  const target = path.resolve(destination)
  if (fs.existsSync(target)) throw new Error('Refusing to overwrite baseline directory: ' + target)
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', BASELINE_REVISION, '--', 'lib', 'native', 'package.json'], { cwd: repository }).toString('utf8').split('\0').filter(Boolean).map(entry => {
    const match = /^100\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry)
    if (!match) throw new Error('Unsupported baseline tree entry')
    const file = path.resolve(target, match[2])
    if (!file.startsWith(target + path.sep)) throw new Error('Invalid baseline path')
    return { hash: match[1], file }
  })
  const objects = execFileSync('git', ['cat-file', '--batch'], { cwd: repository, input: entries.map(item => item.hash).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024 })
  fs.mkdirSync(target)
  let offset = 0
  for (const entry of entries) {
    const end = objects.indexOf(10, offset), header = objects.subarray(offset, end).toString('utf8').split(' '), size = Number(header[2])
    if (header[0] !== entry.hash || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid baseline blob')
    const bytes = objects.subarray(end + 1, end + 1 + size)
    if (bytes.length !== size || objects[end + 1 + size] !== 10) throw new Error('Incomplete baseline blob')
    fs.mkdirSync(path.dirname(entry.file), { recursive: true }); fs.writeFileSync(entry.file, bytes, { flag: 'wx' })
    offset = end + 2 + size
  }
  return { revision: BASELINE_REVISION, directory: target, files: entries.length }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Usage: node bench/gates/prepare-baseline.mjs NEW_DIRECTORY')
  console.log(JSON.stringify(prepareBaseline(process.argv[2])))
}
