import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Context } from '@deepseek-ai/cordis'
import { NativeFileTools } from '../../src/file/runtime.js'
import { resolveWorker, tryResolveWorker } from '../../src/ptc/runtime.js'
declare const ctx: Context
const runtime = new NativeFileTools({ ctx, config: { workerPath: '/worker', toolCallTimeoutMs: 30000 } })
void runtime.definition('read_table')
void runtime.definition('result')
// @ts-expect-error Native definitions cannot expose batch-only APIs.
void runtime.definition('batch')
// @ts-expect-error Timeout configuration is numeric, not an unvalidated string.
void new NativeFileTools({ ctx, config: { toolCallTimeoutMs: '30000' } })
// @ts-expect-error An explicit worker path must be a string.
void resolveWorker({ binaryPath: 3 })
const selected = tryResolveWorker({}, { platform: 'linux', arch: 'x64' })
if (selected.ok) {
  const file: string = selected.file
  // @ts-expect-error Failure detail is unavailable on a successful resolution.
  void selected.reason
  void file
} else {
  const reason: string = selected.reason
  // @ts-expect-error A failed resolution cannot provide a worker path.
  void selected.file
  void reason
}

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { invoke as fileCall, failure as fileFailure } from '../../src/file/worker.js'
declare const exec: ToolRunContext
const nativeValue: unknown = await fileCall(ctx, '/worker', 'stat', { path: 'safe' }, exec, undefined, { denyCredentialReads: true })
// @ts-expect-error The transport result must be narrowed before accessing canonical fields.
void nativeValue.status
// @ts-expect-error A worker executable path cannot be a number.
void fileCall(ctx, 3, 'stat', {}, exec)
// @ts-expect-error Credential policy configuration is boolean.
void fileCall(ctx, '/worker', 'stat', {}, exec, undefined, { denyCredentialReads: 'true' })
// @ts-expect-error Effect state must be an explicit kernel fact.
void fileFailure('RESULT_UNKNOWN', 'lost output', 'execute', 'success')

import { invoke as ptcCall, failure as ptcFailure } from '../../src/ptc/worker.js'
const ptcValue: unknown = await ptcCall(ctx, '/worker', 'result', { action: 'page' }, exec)
// @ts-expect-error A transport receipt is narrowed before caller-specific projection.
void ptcValue.status
// @ts-expect-error A subprocess cancellation signal cannot be a configuration object.
void ptcCall(ctx, '/worker', 'batch', {}, exec, {})
// @ts-expect-error PTC effects follow the same kernel vocabulary as Native effects.
void ptcFailure('RESULT_UNKNOWN', 'lost output', 'success')

import { cargoBuild, findCargo, CargoNotFoundError } from '../../src/rust.js'
const cargo = findCargo({ platform: 'linux', env: { DSH_OPS_CARGO: '/cargo' } })
const built = await cargoBuild({ cargo, sourceDir: '/crate', extraArgs: ['--offline'], onLine: line => { const text: string = line; void text } })
const exitCode: number = built.code
const output: string = built.output
const tried: string[] = new CargoNotFoundError('unavailable', ['/cargo']).tried
// @ts-expect-error Rust builds require a crate source directory.
void cargoBuild({ cargo })
// @ts-expect-error Rust builds require an explicitly resolved toolchain.
void cargoBuild({ sourceDir: '/crate' })
// @ts-expect-error Output handlers receive text rather than byte counts.
void cargoBuild({ cargo, sourceDir: '/crate', onLine: (line: number) => { void line } })
// @ts-expect-error Environment overrides are process environment strings.
void findCargo({ env: { DSH_OPS_CARGO: false } })
void [exitCode, output, tried]
