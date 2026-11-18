import type { ReadStream } from 'node:fs'
import type { Outcome, OpsErrorPayload, SearchExecutionReport, StorageReference } from '../../src/kernel/outcome.js'

const error: OpsErrorPayload = { code: 'INVALID_ARGUMENT', effectState: 'none', retry: 'after-input-change', message: 'Correct path.' }
const complete: Outcome<number> = { status: 'completed', data: 1 }
const partial: Outcome<number> = { status: 'partial', data: 1, coverage: { scannedFiles: 1, matchedCount: 1, isComplete: false }, continuation: 'next' }
const rejected: Outcome<number> = { status: 'rejected', error }
const failedAfterEffects: Outcome<number> = { status: 'error', error: { ...error, effectState: 'applied', retry: 'never' }, data: 1 }
// @ts-expect-error Partial results require explicit coverage and a continuation.
const missingCoverage: Outcome<number> = { status: 'partial', data: 1, continuation: 'next' }
// @ts-expect-error Partial results require a continuation even when coverage is present.
const missingContinuation: Outcome<number> = { status: 'partial', data: 1, coverage: { scannedFiles: 1, matchedCount: 1, isComplete: false } }
// @ts-expect-error A completed result cannot claim incomplete coverage.
const incompleteSuccess: Outcome<number> = { status: 'completed', data: 1, coverage: { scannedFiles: 1, matchedCount: 1, isComplete: false } }
// @ts-expect-error Failed results require the structured error payload.
const missingError: Outcome<number> = { status: 'unknown' }
// @ts-expect-error Retry advice uses the stable vocabulary.
const invalidRetry: OpsErrorPayload = { ...error, retry: 'retry-now' }

function result(value: Outcome<number>): number | string {
  if (value.status === 'completed') return value.data
  if (value.status === 'partial') {
    // @ts-expect-error Partial is a data/continuation state, not an error state.
    void value.error
    return value.continuation
  }
  return value.error.code
}
const base = { pageComplete: true, scannedFiles: 1, skippedFiles: 0, skipReasons: {}, matchedObserved: 2, truncatedBy: 'none' as const }
const full: SearchExecutionReport = { ...base, scanComplete: true, matchedTotal: 2 }
const stopped: SearchExecutionReport = { ...base, scanComplete: false }
// @ts-expect-error An incomplete physical scan must not claim a known total.
const falseTotal: SearchExecutionReport = { ...base, scanComplete: false, matchedTotal: 2 }
// @ts-expect-error A complete physical scan reports its known total.
const missingTotal: SearchExecutionReport = { ...base, scanComplete: true }
const reference: StorageReference = { refId: 'ref://session/tool/id', createdAt: 0, ttlMs: 0, schemaVersion: '1', producerTool: 'tool', totalItems: 2, totalBytes: 20, preview: 'first' }
// @ts-expect-error References use the versioned reference syntax, not filesystem paths.
const invalidRef: StorageReference = { ...reference, refId: '/tmp/result.json' }
// The pinned Node major's declarations resolve without adding host runtime imports.
const streamReadable = (stream: ReadStream): boolean => stream.readable
void [complete, partial, rejected, failedAfterEffects, result, full, stopped, reference, streamReadable]
