/**
 * Locating a Rust toolchain and running a release build of a crate.
 *
 * The native worker is a Rust executable, so a source checkout needs one
 * explicit, reproducible build step (`dsh-ops build-ptc`). This module owns it:
 * find `cargo` without guessing, run the release build, and report the exact
 * toolchain that produced the binary.
 *
 * @module dsh-ops/rust
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CargoDiscoveryOptions { env?: NodeJS.ProcessEnv; platform?: string }
export interface CargoToolchain { file: string; source: string; version: string; env: NodeJS.ProcessEnv }
export interface CargoBuildOptions {
  cargo: Pick<CargoToolchain, 'file' | 'env'>
  sourceDir: string
  extraArgs?: readonly string[]
  onLine?: (line: string) => void
}
export interface CargoBuildResult { code: number; output: string }

/** Environment variable that names the `cargo` executable to use. */
export const CARGO_ENV = 'DSH_OPS_CARGO'

/** Error raised when no usable Rust toolchain is found. */
export class CargoNotFoundError extends Error {
  readonly tried: string[]
  /**
   * @param {string} message - the failure summary.
   * @param {string[]} tried - every candidate considered.
   */
  constructor(message: string, tried: string[]) {
    super(message)
    this.name = 'CargoNotFoundError'
    this.tried = tried
  }
}

/**
 * One process run, with its output collected.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} options - run inputs.
 * @param {string} [options.cwd] - working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - environment.
 * @returns {{status: number|null, stdout: string, stderr: string}} the outcome.
 */
function run(command: string, args: readonly string[], { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

/**
 * Candidate `cargo` executables, most explicit first.
 * @param {object} [options] - discovery inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string, source: string}[]} the candidates.
 */
function cargoCandidates({ env = process.env, platform = process.platform }: CargoDiscoveryOptions = {}): { file: string; source: string }[] {
  const name = platform === 'win32' ? 'cargo.exe' : 'cargo'
  const candidates: { file: string; source: string }[] = []
  if (env[CARGO_ENV] !== undefined && env[CARGO_ENV].trim() !== '') {
    candidates.push({ file: path.resolve(env[CARGO_ENV]), source: CARGO_ENV })
  }
  const cargoHome = env.CARGO_HOME
  if (cargoHome !== undefined && cargoHome.trim() !== '') {
    candidates.push({ file: path.join(cargoHome, 'bin', name), source: 'CARGO_HOME' })
  }
  candidates.push({ file: path.join(os.homedir(), '.cargo', 'bin', name), source: 'user cargo home' })
  // A relocated toolchain (a shared development drive, a CI image) is reached
  // through DSH_OPS_RUST_HOME, which names the directory holding `.cargo`.
  const rustHome = env.DSH_OPS_RUST_HOME
  if (rustHome !== undefined && rustHome.trim() !== '') {
    candidates.push({ file: path.join(rustHome, '.cargo', 'bin', name), source: 'DSH_OPS_RUST_HOME' })
  }
  candidates.push({ file: name, source: 'PATH' })
  return candidates
}

/**
 * Find a working `cargo`.
 *
 * `DSH_OPS_CARGO` is authoritative: when it names something unusable the search
 * fails instead of silently building with a different toolchain.
 * @param {object} [options] - discovery inputs.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read.
 * @param {string} [options.platform] - `process.platform`.
 * @returns {{file: string, source: string, version: string, env: NodeJS.ProcessEnv}} the toolchain.
 * @throws {CargoNotFoundError} when no usable `cargo` is found.
 */
export function findCargo({ env = process.env, platform = process.platform }: CargoDiscoveryOptions = {}): CargoToolchain {
  const tried: string[] = []
  for (const candidate of cargoCandidates({ env, platform })) {
    if (candidate.file !== 'cargo' && candidate.file !== 'cargo.exe' && !fs.existsSync(candidate.file)) {
      tried.push(`${candidate.source}: ${candidate.file} (missing)`)
      continue
    }
    const probe = run(candidate.file, ['--version'], { env })
    if (probe.status === 0) {
      return { ...candidate, version: probe.stdout.trim(), env }
    }
    tried.push(`${candidate.source}: ${candidate.file} (${probe.stderr.trim().split('\n')[0] || `exited ${probe.status}`})`)
    if (candidate.source === CARGO_ENV) {
      throw new CargoNotFoundError(`${CARGO_ENV} does not name a working cargo`, tried)
    }
  }
  throw new CargoNotFoundError(
    'no working Rust toolchain found; install Rust, or set DSH_OPS_CARGO to the cargo executable, '
    + 'or set CARGO_HOME to the toolchain home',
    tried,
  )
}

/**
 * Run `cargo build --release` over one crate, streaming its output to the
 * caller's terminal.
 * @param {object} options - build inputs.
 * @param {object} options.cargo - the toolchain from {@link findCargo}.
 * @param {string} options.sourceDir - the crate to build (the directory holding its `Cargo.toml`).
 * @param {string[]} [options.extraArgs] - additional cargo arguments.
 * @param {(line: string) => void} [options.onLine] - receives each output line.
 * @returns {Promise<{code: number, output: string}>} the exit code and everything cargo wrote.
 */
export function cargoBuild(options: CargoBuildOptions): Promise<CargoBuildResult> {
  const { cargo, sourceDir, extraArgs = [], onLine } = options ?? {}
  if (typeof sourceDir !== 'string' || sourceDir === '') throw new Error('cargoBuild requires the crate sourceDir')
  const args = ['build', '--release', '--locked', ...extraArgs]
  return new Promise((resolve, reject) => {
    const child = spawn(cargo.file, args, {
      cwd: sourceDir,
      env: cargo.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const forward = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      if (onLine !== undefined) for (const line of text.split('\n')) if (line !== '') onLine(line)
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, output }))
  })
}
