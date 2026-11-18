/** Retry policy is explicit and cannot turn uncertain effects into a replay instruction. */
import { ERROR_POLICIES, errorPolicy } from '../lib/kernel/errors.js'
import { assert, test, report } from './lib/harness.mjs'

await test('permission, input, revision and transient failures have distinct advice', () => {
  for (const code of ['POLICY_DENIED', 'CREDENTIAL_DENIED', 'PATH_RESTRICTED']) assert.deepEqual(errorPolicy(code), { status: 'rejected', retry: 'never' })
  assert.deepEqual(errorPolicy('REVISION_CONFLICT'), { status: 'conflict', retry: 'after-state-change' })
  for (const code of ['INVALID_ARGUMENT', 'EDIT_CONFLICT', 'OUTPUT_LIMIT', 'ERR_INVALID_ENCODING', 'SEARCH_STALE']) assert.deepEqual(errorPolicy(code), { status: 'error', retry: 'after-input-change' })
  assert.deepEqual(errorPolicy('JOB_BUSY'), { status: 'error', retry: 'bounded-transient' })
  for (const code of ['ACCESS_DENIED', 'AUTHORITY_CHANGED', 'EXECUTOR_UNAVAILABLE', 'CALL_LIMIT']) assert.deepEqual(errorPolicy(code), { status: 'error', retry: 'after-state-change' })
  for (const code of ['METADATA_UNSUPPORTED', 'IO_ERROR', 'NEW_CODE', 'toString', '__proto__', 'CANCELLED']) assert.deepEqual(errorPolicy(code), { status: 'error', retry: 'never' })
})

await test('an executed nonzero exit is the documented retry exception', () => {
  // #331/#341: the Bash failure payload reports effectState 'unknown' with retry
  // 'after-input-change' for EXIT_CODE. This entry is the discoverable record of that explicit
  // exception; removing it turns the assertion red and re-opens a silent downgrade to 'never'.
  assert.deepEqual(ERROR_POLICIES.EXIT_CODE, { status: 'error', retry: 'after-input-change' })
  assert.deepEqual(errorPolicy('EXIT_CODE'), { status: 'error', retry: 'after-input-change' })
  // The exception stays narrow: unknown effects still dominate inside errorPolicy itself.
  assert.deepEqual(errorPolicy('EXIT_CODE', 'unknown'), { status: 'unknown', retry: 'never' })
})

await test('unknown or already-applied effects override every ordinary retry policy', () => {
  for (const code of [...Object.keys(ERROR_POLICIES), 'NEW_CODE']) {
    assert.deepEqual(errorPolicy(code, 'unknown'), { status: 'unknown', retry: 'never' })
    for (const effect of ['partial', 'applied']) assert.equal(errorPolicy(code, effect).retry, 'never')
  }
  for (const code of ['RESULT_UNKNOWN', 'EXECUTION_RESTRICTED']) assert.deepEqual(errorPolicy(code), { status: 'unknown', retry: 'never' })
  assert.deepEqual(errorPolicy('REVISION_CONFLICT', 'applied'), { status: 'error', retry: 'never' })
  assert.deepEqual(errorPolicy('OUTPUT_LIMIT', 'unknown'), { status: 'unknown', retry: 'never' })
})
report('kernel-errors')
