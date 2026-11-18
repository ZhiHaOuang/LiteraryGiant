/** Constant-memory aggregate notifications; never a current-session status or issue ledger. */
export type AttentionLevel = 'error' | 'warning'
export interface AttentionSnapshot { readonly unread: number; readonly capped: boolean; readonly level: AttentionLevel | undefined }
export interface AttentionStore {
  snapshot(): AttentionSnapshot
  observe(row: unknown): boolean
  acknowledge(): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
}
const EMPTY: AttentionSnapshot = Object.freeze({ unread: 0, capped: false, level: undefined })
export const ALERT_CAP = 999

function rowFields(row: unknown): row is { status?: unknown; outcome?: unknown } {
  return row !== null && typeof row === 'object'
}
export function anomalyLevel(row: unknown): AttentionLevel | undefined {
  if (!rowFields(row)) return undefined
  if (row?.status === 'error' || row?.outcome === 'error' || row?.outcome === 'unknown') return 'error'
  if (row?.outcome === 'rejected' || row?.outcome === 'partial') return 'warning'
}

/** Record only newly accepted settlements. Deduplication belongs to the activity store. */
export function createAttentionStore(): AttentionStore {
  const listeners = new Set<() => void>()
  let snapshot = EMPTY, disposed = false
  function publish(next: AttentionSnapshot): void {
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) {
      try { listener() } catch { /* Notification failures cannot alter tool results. */ }
    }
  }
  return Object.freeze({
    snapshot: () => snapshot,
    observe(row: unknown) {
      const level = anomalyLevel(row)
      if (disposed || !level) return false
      const next: AttentionSnapshot = { unread: Math.min(ALERT_CAP, snapshot.unread + 1), capped: snapshot.capped || snapshot.unread === ALERT_CAP,
        level: snapshot.level === 'error' ? 'error' : level }
      // Even at the cap, a new anomaly must relight a host-cleared tab indicator.
      publish(next)
      return true
    },
    acknowledge() {
      if (disposed || snapshot === EMPTY) return false
      publish(EMPTY)
      return true
    },
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      publish(EMPTY)
      listeners.clear()
    },
  })
}
