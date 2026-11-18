import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { credentialPath, credentialRoots } from '../../src/credential-policy.js'
import { anchoredPath, sessionAnchors } from '../../src/authority-paths.js'
import { authorityChanged, credentialDenied, denied, executionRestriction, normalizeNativeDenial, permissionError } from '../../src/permissions.js'

const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/work' }
const error = permissionError(policy, 'copy')
const rejected: 'rejected' = denied(policy, 'copy').status
const code: 'POLICY_DENIED' = error.code
const effect: 'none' = error.effectState
const credentialCode: 'CREDENTIAL_DENIED' = credentialDenied('denied').error.code
const restrictionEffect: 'unknown' = executionRestriction('copy').effectState
const changedCode: 'AUTHORITY_CHANGED' = authorityChanged(undefined, 'copy').error.code
const verdict = credentialPath('/work/file', { env: {} })
if (verdict.denied) { const matched: string = verdict.matched; void matched }
else {
  // @ts-expect-error A permitted path has no matching credential rule.
  void verdict.matched
}
const roots: string[] = credentialRoots({ home: '/home', env: {} })
const absolute: string = anchoredPath('/work/file', roots)
const anchors: string[] = sessionAnchors(policy)
const original = { changed: 1, receipt: { complete: false }, status: 'error', error: { code: 'POLICY_DENIED', reason: 'write-roots' } }
const normalized = normalizeNativeDenial(original, policy, 'copy')
const count: number = normalized.changed
const complete: boolean = normalized.receipt.complete
const untrusted: unknown = { error: null }
const unchecked = normalizeNativeDenial(untrusted, policy, 'copy')
// @ts-expect-error Unknown worker data must be narrowed before its properties are consumed.
void unchecked.status
// @ts-expect-error Policy mode must use the host selector vocabulary.
permissionError({ mode: 'allow', workspaceRoot: '/work' }, 'copy')
// @ts-expect-error A required mode is not model-selected free text.
permissionError(policy, 'copy', 'retry')
// @ts-expect-error A policy without an authoritative workspace root is incomplete.
denied({ mode: 'workspace-write' }, 'copy')
// @ts-expect-error Trusted anchors must contain paths, never coerced scalars.
anchoredPath('/work/file', [42])
// @ts-expect-error Credential environments contain string values, not booleans.
credentialRoots({ env: { DSH_OPS_DENY_READ: true } })
void [rejected, code, effect, credentialCode, restrictionEffect, changedCode, absolute, anchors, count, complete]
