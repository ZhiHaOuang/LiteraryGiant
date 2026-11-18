#!/usr/bin/env node
/**
 * release-pack.mjs — the two tarballs a release publishes (D47).
 *
 * A release publishes twice: minutes after the tag push the version goes out as
 * `<version>-dev.<run number>` under npm's `dev` tag so it can be tried before
 * the gates finish, and the same files with the version field restored go out as
 * `latest` once the gates pass. Both come from this one pack, so the two
 * tarballs differ in the version field alone.
 *
 * `npm pack` writes the package's own file list and manifest, and the build runs
 * here rather than being assumed: `lib/` is not in version control (D47), so a
 * fresh checkout has none (`npm pack` runs `prepack` and `prepare`, never
 * `prepublishOnly`).
 *
 * Both tarballs are published as tarballs, which is what keeps the promotion
 * honest: npm runs no lifecycle script for a tarball, so what `latest` gets is
 * the bytes this run packed rather than a second build of the same sources.
 *
 * Usage: node scripts/release-pack.mjs [--out <dir>] [--dev <version>]
 * Progress goes to stderr; stdout carries the tarball paths, one per line, the
 * release first.
 */
import fs from 'node:fs'
import path from 'node:path'
import { runner } from './shared/run.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_OUT = path.join(ROOT, '.debug', 'release')
const run = runner(ROOT)

function fail(message) {
  console.error(`release-pack: ${message}`)
  process.exit(1)
}

/** The last non-empty line of a command's stdout, which is where npm names what it wrote. */
const lastLine = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''

const args = process.argv.slice(2)
const argOf = (flag) => {
  const at = args.indexOf(`--${flag}`)
  return at === -1 ? undefined : args[at + 1]
}
const dev = argOf('dev')
if (args.includes('--dev') && (dev === undefined || dev.trim() === '' || dev.startsWith('--'))) {
  fail('--dev needs the dev version to write into the tarball')
}
const out = path.resolve(argOf('out') ?? DEFAULT_OUT)

// A tarball left by an earlier run would otherwise sit beside this one and make
// the printed paths ambiguous.
fs.rmSync(out, { recursive: true, force: true })
const pack = path.join(out, 'pack')
fs.mkdirSync(pack, { recursive: true })

console.error('release-pack: build')
run('npm', ['run', 'build'])
const release = path.join(pack, lastLine(run('npm', ['pack', '--pack-destination', pack])).replace(/^.*[\\/]/, ''))
if (!fs.existsSync(release)) fail(`npm pack wrote no tarball under ${pack}`)
console.error(`release-pack: ${path.basename(release)}`)

const paths = [release]
if (dev !== undefined) {
  const staged = path.join(out, 'dev')
  fs.mkdirSync(staged, { recursive: true })
  run('tar', ['-xzf', release, '-C', staged, '--strip-components=1'])
  const manifest = path.join(staged, 'package.json')
  const copy = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  copy.version = dev
  fs.writeFileSync(manifest, `${JSON.stringify(copy, null, 2)}\n`)
  // Packing the staged directory runs `prepack` and `prepare` only; the package
  // declares neither, and the tarball's own `prepublishOnly` never runs.
  const devName = lastLine(run('npm', ['pack', staged, '--pack-destination', out])).replace(/^.*[\\/]/, '')
  const devTarball = path.join(out, devName)
  if (!fs.existsSync(devTarball)) fail(`npm pack wrote no dev tarball under ${out}`)
  console.error(`release-pack: ${devName}`)
  paths.push(devTarball)
}

process.stdout.write(`${paths.join('\n')}\n`)
