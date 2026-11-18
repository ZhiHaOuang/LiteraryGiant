/** Shared DSH permission vocabulary. Model inputs never select an authority mode. */
import type { SandboxExecutionPolicy, SandboxMode } from './adapter/dsh/types.js'

export type AuthorityPolicy = Pick<SandboxExecutionPolicy, 'mode' | 'workspaceRoot'>
export const MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
export function permissionError(policy: AuthorityPolicy, operation: string, required: SandboxMode = 'workspace-write', message = '', nextAction?: string) {
  return {
    code: 'POLICY_DENIED' as const, phase: 'preflight' as const, retryable: false as const, effectState: 'none' as const,
    permission: { current: policy.mode, required, operation, workspaceRoot: policy.workspaceRoot },
    message: `User authorization does not permit ${operation} in DSH mode ${policy.mode}. ${message}`.trim(),
    nextAction: nextAction ?? `Ask the user to change the DSH permission selector to ${required}. Do not retry, change directories, or bypass the sandbox.`,
  }
}
export function denied(policy: AuthorityPolicy, operation: string, required?: SandboxMode, message?: string, nextAction?: string) {
  return { status: 'rejected' as const, error: permissionError(policy, operation, required, message, nextAction), sandbox: { mode: policy.mode } }
}

/** A changed snapshot is not proof that the current authorization is insufficient. */
export function authorityChanged(policy: Pick<AuthorityPolicy, 'mode'> | undefined, operation: string) {
  return { status: 'error' as const, error: {
    code: 'AUTHORITY_CHANGED' as const, phase: 'preflight' as const, retryable: false as const, effectState: 'none' as const,
    message: `DSH authority changed while preparing ${operation}; no operation was started.`,
    nextAction: 'Confirm the current session authority before making a new request. Do not blindly retry or bypass confinement.',
  }, sandbox: { mode: policy?.mode } }
}

export function executionRestriction(operation: string) {
  return { code: 'EXECUTION_RESTRICTED' as const, phase: 'execute' as const, retryable: false as const, effectState: 'unknown' as const,
    message: `${operation} encountered an execution restriction; stderr alone does not establish a DSH user authorization denial.`,
    nextAction: 'Inspect postconditions and host path, platform and OS permissions. Do not blindly retry or bypass confinement; changing the DSH selector may not resolve this restriction.' }
}

type NormalizedDenial<T> = Omit<T, 'status' | 'error'> & {
  status: 'rejected'
  error: Omit<ReturnType<typeof permissionError>, 'phase' | 'effectState'> & Record<string, unknown> & { phase: unknown; effectState: unknown }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
/** Only additive, recognized native reasons prove a selector denial; legacy codes alone do not. */
export function normalizeNativeDenial<T extends Record<string, unknown>>(value: T, policy: AuthorityPolicy, operation: string, required?: SandboxMode): T | NormalizedDenial<T>
export function normalizeNativeDenial(value: unknown, policy: AuthorityPolicy, operation: string, required?: SandboxMode): unknown
export function normalizeNativeDenial(value: unknown, policy: AuthorityPolicy, operation: string, required?: SandboxMode): unknown {
  if (!record(value) || !record(value.error) || value.error.code !== 'POLICY_DENIED'
    || (value.error.reason !== 'read-only' && value.error.reason !== 'write-roots')) return value
  const permission = permissionError(policy, operation, value.error.reason === 'write-roots' ? 'danger-full-access' : required)
  return { ...value, status: 'rejected' as const, error: { ...value.error, ...permission,
    phase: value.error.phase ?? permission.phase, effectState: value.error.effectState ?? permission.effectState,
    nextAction: `${permission.nextAction} Inspect any reported effects before a new attempt.` } }
}

export function credentialDenied(message: string) {
  return { status: 'rejected' as const, error: { code: 'CREDENTIAL_DENIED' as const, phase: 'preflight' as const, retryable: false as const, effectState: 'none' as const, message,
    nextAction: 'Choose a non-credential path. Do not retry or bypass the credential fence; changing the DSH permission selector does not remove it.' } }
}
