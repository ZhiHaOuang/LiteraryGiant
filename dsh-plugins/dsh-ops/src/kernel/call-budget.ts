/** Bound this plugin's workers without changing host admission or tool registries. */
export const MAX_ACTIVE_CALLS = 2
export const MAX_WAITING_CALLS = 8

export class CallBudgetError extends Error {
  constructor(readonly code: 'CALL_LIMIT' | 'CANCELLED', message: string) { super(message) }
}
type Ticket = { resolve: (release: () => void) => void, reject: (reason: unknown) => void,
  signal?: AbortSignal, abort: () => void }
type Lane = { active: number, queue: Ticket[] }
const owners = new WeakMap<object, Map<string, Lane>>()

function cancelled(): CallBudgetError { return new CallBudgetError('CANCELLED', 'OPS call cancelled before worker admission; no effects.') }

/** FIFO permits are scoped to one host and session, shared by Native and PTC bridges. */
async function acquire(owner: object, sessionId: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw cancelled()
  let sessions = owners.get(owner)
  if (!sessions) { sessions = new Map(); owners.set(owner, sessions) }
  let lane = sessions.get(sessionId)
  if (!lane) { lane = { active: 0, queue: [] }; sessions.set(sessionId, lane) }
  const current = lane
  const cleanup = () => { if (current.active === 0 && current.queue.length === 0) sessions.delete(sessionId) }
  const releaseOnce = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      current.active--
      const next = current.queue.shift()
      if (next) {
        next.signal?.removeEventListener('abort', next.abort)
        current.active++
        next.resolve(releaseOnce())
      }
      cleanup()
    }
  }
  if (current.active < MAX_ACTIVE_CALLS) { current.active++; return releaseOnce() }
  if (current.queue.length >= MAX_WAITING_CALLS) {
    throw new CallBudgetError('CALL_LIMIT', 'OPS call queue is full. Wait for current calls to finish before submitting more work; no effects.')
  }
  return new Promise((resolve, reject) => {
    const ticket: Ticket = { resolve, reject, ...(signal ? { signal } : {}), abort: () => {
      const index = current.queue.indexOf(ticket)
      if (index < 0) return
      current.queue.splice(index, 1)
      reject(cancelled()); cleanup()
    } }
    current.queue.push(ticket)
    signal?.addEventListener('abort', ticket.abort, { once: true })
    if (signal?.aborted) ticket.abort()
  })
}

export async function withCallBudget<T>(owner: object, sessionId: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const release = await acquire(owner, sessionId, signal)
  try {
    if (signal?.aborted) throw cancelled()
    return await run()
  } finally { release() }
}
