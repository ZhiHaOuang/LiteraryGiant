import { randomUUID } from 'node:crypto'
import { CallBudgetError } from './call-budget.js'

export interface ResultSession { id: string; header?: { cwd?: string } }
export interface LifecycleHost {
  root?: object
  on(name: 'session/disposed', callback: (session: ResultSession) => void): unknown
  on(name: 'session/event', callback: (session: ResultSession, event: { type: string }) => void): unknown
  effect(callback: () => (() => Promise<void>), label: string): unknown
  logger?: { warn?: (message: string) => void }
}
interface LiveSession {
  nonce: string
  stopped: boolean
  work: Map<AbortController, Promise<unknown>>
  cleanup: Map<string, () => Promise<void>>
  closing?: Promise<void>
}
interface Owner { mounts: number; sessions: Map<ResultSession, LiveSession>; expired: WeakSet<ResultSession> }
const owners = new WeakMap<object, Owner>()
function owner(ctx: Pick<LifecycleHost, 'root'>): Owner {
  const key = ctx.root ?? ctx
  let state = owners.get(key)
  if (!state) { state = { mounts: 0, sessions: new Map(), expired: new WeakSet() }; owners.set(key, state) }
  return state
}
function live(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession): LiveSession {
  const state = owner(ctx)
  if (state.expired.has(session)) throw new Error('Result session has expired')
  // The pinned SessionStore emits its exact stored Session object throughout one lifetime.
  if ([...state.sessions].some(([other, entry]) => other !== session && other.id === session.id && !entry.stopped)) {
    throw new Error('Another live session owns this identity')
  }
  let entry = state.sessions.get(session)
  if (!entry) {
    entry = { nonce: randomUUID(), stopped: false, work: new Map(), cleanup: new Map() }
    state.sessions.set(session, entry)
  }
  if (entry.stopped) throw new Error('Result session is closing')
  return entry
}
/** A reopened persisted session receives a fresh authority binding, even with the same id. */
export function resultSessionNonce(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession): string {
  return live(ctx, session).nonce
}
export function registerResultCleanup(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession, key: string, cleanup: () => Promise<void>): void {
  live(ctx, session).cleanup.set(key, cleanup)
}
export async function withResultSession<T>(ctx: Pick<LifecycleHost, 'root'>, session: ResultSession,
  signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const entry = live(ctx, session), controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  // Defer invocation so teardown always sees the promise before any worker can start.
  const preceding = [...owner(ctx).sessions].filter(([other]) => other !== session && other.id === session.id)
    .map(([, entry]) => entry.closing)
  const work = Promise.resolve().then(async () => {
    await Promise.allSettled(preceding)
    if (controller.signal.aborted) throw new CallBudgetError('CANCELLED', 'OPS call cancelled before worker admission; no effects.')
    return run(controller.signal)
  })
  entry.work.set(controller, work)
  try { return await work }
  finally { entry.work.delete(controller); signal?.removeEventListener('abort', abort) }
}
export function expireResultSession(ctx: Pick<LifecycleHost, 'root' | 'logger'>, session: ResultSession, disposed = true): Promise<void> {
  const state = owner(ctx), entry = state.sessions.get(session)
  if (disposed) state.expired.add(session)
  if (!entry) return Promise.resolve()
  if (entry.closing) return entry.closing
  entry.stopped = true
  // Publish the barrier before abort listeners can synchronously reopen the same id.
  entry.closing = Promise.resolve().then(async () => {
    await Promise.allSettled(entry.work.values())
    for (const cleanup of entry.cleanup.values()) {
      try { await cleanup() }
      catch { ctx.logger?.warn?.('dsh-ops: session result references expired; physical cache cleanup did not complete under current host authority. Temporary files remain for host or operator cleanup; no automatic retry is scheduled.') }
    }
    entry.cleanup.clear(); state.sessions.delete(session)
  })
  for (const controller of entry.work.keys()) controller.abort(new Error('Result session disposed'))
  return entry.closing
}
/** Each component owns its listeners. Last-owner teardown expires remaining sessions. */
export function mountResultLifecycle(ctx: LifecycleHost): void {
  const state = owner(ctx); state.mounts++
  ctx.on('session/disposed', session => { void expireResultSession(ctx, session) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'sandbox/mode') return
    for (const [other, entry] of state.sessions) if (other === session) {
      for (const controller of entry.work.keys()) controller.abort(new Error('Sandbox authority changed'))
    }
  })
  ctx.effect(() => async () => {
    if (--state.mounts !== 0) return
    await Promise.allSettled([...state.sessions.keys()].map(session => expireResultSession(ctx, session, false)))
  }, 'dsh-ops: session result lifecycle')
}
