import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE } from './apiRoutes'
import { lruTouch, lruTrim } from './lru'
import { asRecord, timelineOf } from './services'

export interface AgentHeads {
  headOf(id: string): Promise<ContextTimeline | null>
}

export function makeHeadFetcher(sessionId: string): (() => Promise<ContextTimeline | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, head: true }),
    })
    if (!response.ok) throw new Error(`dsh-context: head route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: head read failed')
    if (r.value === null) return null
    const head = timelineOf(asRecord(r.value)?.head)
    if (head === null) throw new Error('dsh-context: head read malformed')
    return head
  }
}

const HEADS_MAX = 128

export function makeAgentHeads(): AgentHeads {
  const heads = new Map<string, Promise<ContextTimeline | null>>()
  return {
    headOf(id: string): Promise<ContextTimeline | null> {
      const cached = heads.get(id)
      if (cached !== undefined) {
        lruTouch(heads, id)
        return cached
      }
      const fetcher = makeHeadFetcher(id)
      const pending = fetcher !== undefined ? fetcher() : Promise.resolve(null)
      heads.set(id, pending)
      lruTrim(heads, HEADS_MAX)
      return pending
    },
  }
}

export function useSessionsSnapshot(face: SessionsFaceLike | null, coalesceMs = 0): unknown {
  const subscribe = useCallback((fn: () => void) => {
    if (face === null) return () => {}
    /* v8 ignore next 2 */
    if (face.list === undefined) return () => {}
    if (coalesceMs <= 0) return face.list.subscribe(fn)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = face.list.subscribe(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, coalesceMs)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [face, coalesceMs])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
