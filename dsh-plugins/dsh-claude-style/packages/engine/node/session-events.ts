/**
 * Reading raw session logs through the host's own reader.
 *
 * Every host-half reader of stored sessions goes through this one call, and which `sessionQuery` entry point it uses is a performance
 * decision as much as a correctness one:
 *
 *   - `readSession` resolves one session by id, but the service finds that id by
 *     listing the WHOLE stored corpus first, and a listing opens and
 *     decompresses every stored session's header. A pass that reads every log
 *     this way pays that walk once per session, which is what made a fold over a
 *     whole corpus quadratic
 *   - `observeSession` resolves one session from its own `stat` alone: no corpus
 *     listing, and it hands back a disposable lease over the same complete,
 *     detached log. N sessions therefore cost N observations and no listings.
 *     The service's batch reader is NOT a substitute: `readTitleSnapshots`
 *     projects titles and discards the events, so a caller that expects a log
 *     from it folds nothing while still reporting successful reads.
 *
 * `observeSession` is what this module reads through, and `readSession` stays as
 * the fallback for a host that publishes only it.
 *
 * Either way the same two codes mean "this session has nothing to give right
 * now" (D12): an unreadable or vanished log is one session left
 * out, reported once, and every other failure propagates. The host ships no type
 * for the events, so the caller names the shape it reads.
 *
 * @param ctx - host plugin context, for the `sessionQuery` service.
 * @param packageName - the plugin's name, which prefixes the warning a tolerated failure leaves.
 * @param sessionId - the session whose log is read.
 * @param label - what the caller is doing, for the warning a tolerated failure leaves.
 * @returns the events, or null when there is no reader or the log cannot be read.
 */
import type { DshContext, DshSessionObservation } from './dsh'

/** The `sessionQuery` service, in the members this module reads. */
interface QueryReader {
  observeSession?(sessionId: string, options?: { projectionMode?: 'all' | 'none' }): Promise<DshSessionObservation>
  readSession?(sessionId: string): Promise<{ events?: unknown } | null | undefined>
}

/** The caller's events out of whatever the host hands back, or null when it is not a log. */
function eventsOf<T>(events: unknown): T[] | null {
  return Array.isArray(events) ? events as T[] : null
}

/**
 * The refusal the two tolerated codes stand for: the service read no log for
 * this session, and the next pass may do better.
 *
 * @param error - what the reader threw.
 * @returns the failure, or null when it is a failure the caller must handle itself.
 */
function unreadableLog(error: unknown): { message?: string } | null {
  const failure = error as { code?: string, message?: string } | null
  return failure?.code === 'SESSION_QUERY_CORRUPT_SESSION' || failure?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
    ? failure
    : null
}

/** Report one session the reader refused, naming the pass it was left out of. */
function reportUnreadable(ctx: DshContext, packageName: string, error: unknown, sessionId: string, label: string) {
  ctx.logger?.warn?.(`${packageName}: session ${sessionId} left out of ${label}: ${unreadableLog(error)?.message}`)
}

/**
 * Release one observation's lease.
 *
 * The host's lease exposes its release as `Symbol.dispose`; a named `dispose` is
 * what a host that publishes one carries instead.
 */
function releaseObservation(observation: DshSessionObservation) {
  const named = (observation as { dispose?: () => void }).dispose
  if (typeof named === 'function') named.call(observation)
  else if (Symbol.dispose in observation) (observation as unknown as { [Symbol.dispose](): void })[Symbol.dispose]()
}

export async function readEvents<T>(ctx: DshContext, packageName: string, sessionId: string, label: string): Promise<T[] | null> {
  const query = ctx.get('sessionQuery') as QueryReader | null | undefined
  if (query === null || query === undefined) return null
  try {
    if (typeof query.observeSession === 'function') {
      // `projectionMode: 'none'` keeps the host's own projection computation off
      // a read that only wants the events; the lease is released as soon as they
      // are in hand.
      const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
      try {
        return eventsOf<T>(observation.events)
      } finally {
        releaseObservation(observation)
      }
    }
    if (typeof query.readSession !== 'function') return null
    const snapshot = await query.readSession(sessionId)
    return eventsOf<T>(snapshot?.events)
  } catch (error) {
    if (unreadableLog(error) === null) throw error
    reportUnreadable(ctx, packageName, error, sessionId, label)
    return null
  }
}
