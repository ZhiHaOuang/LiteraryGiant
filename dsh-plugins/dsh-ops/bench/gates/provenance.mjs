import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const repository = fileURLToPath(new URL('../../', import.meta.url))
export const BASELINE_REVISION = '4b51b6333213c376c8b7c173c12f35b408fdec2d'
export function baselineProvenance(source, binary) {
  if (!source || !binary) throw new Error('BM-01 requires --baseline-source and --baseline-worker; missing baseline is not a pass')
  const revision = execFileSync('git', ['rev-parse', BASELINE_REVISION + '^{commit}'], { cwd: repository, encoding: 'utf8' }).trim()
  const entries = execFileSync('git', ['ls-tree', '-r', revision, '--', 'lib', 'native'], { cwd: repository, encoding: 'utf8' }).trim().split('\n')
  let verifiedFiles = 0
  for (const entry of entries) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry)
    if (!match) throw new Error('Unsupported baseline tree entry: ' + entry)
    const file = path.join(source, match[2]), bytes = fs.readFileSync(file)
    const actual = createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex')
    if (actual !== match[1]) throw new Error('Baseline source differs from ' + revision + ': ' + match[2])
    ++verifiedFiles
  }
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (version.error || version.status !== 0 || version.stdout.trim() !== 'dsh-ops-worker 0.3.1') throw new Error('Baseline must be an explicit source-built 0.3.1 worker')
  return { revision, verifiedFiles, source, binary, workerSha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    binaryAttestation: 'Version and hash recorded; source matches Git blobs. No reproducible-build attestation is claimed.' }
}
