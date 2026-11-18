import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from '../commands'
import type { CommandPageFetcher } from '../commandPages'

const PAGE_PAUSE_MS = 30

type FillState =
  | { status: 'idle' }
  | { status: 'done' }
  | { status: 'loading'; cursor: number; total?: number }
  | { status: 'failed'; cursor: number }

export interface CommandLog {
  records: Command[]
  status: FillState['status']
  total?: number
  retry: () => void
}

export type CommandFill = Pick<CommandLog, 'status' | 'total'> & { retry?: () => void }

function knownWithServed(prev: ReadonlyMap<number, Command>, served: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of served) {
    if (prev.get(rec.seq) === rec) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

function knownWithPage(prev: ReadonlyMap<number, Command>, incoming: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of incoming) {
    if (prev.has(rec.seq)) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

export function useCommandLog(
  served: readonly Command[],
  floor: number | undefined,
  fetchOlder: CommandPageFetcher | undefined,
): CommandLog {
  const [known, setKnown] = useState<ReadonlyMap<number, Command>>(() => new Map())
  const [fill, setFill] = useState<FillState>({ status: 'idle' })
  const cursorTarget = useRef(0)
  useEffect(() => {
    if (served.length === 0 || floor === undefined) return
    setKnown(prev => knownWithServed(prev, served))
  }, [served, floor])
  const records = useMemo<Command[]>(() => {
    if (floor === undefined || known.size === 0) return served as Command[]
    const merged = new Map(known)
    for (const rec of served) merged.set(rec.seq, rec)
    return [...merged.values()]
  }, [served, known, floor])
  useEffect(() => {
    if (fill.status !== 'idle' || floor === undefined || served.length === 0 || fetchOlder === undefined) return
    const cursor = floor + 1
    cursorTarget.current = cursor
    setFill({ status: 'loading', cursor })
  }, [fill.status, floor, served.length, fetchOlder])
  useEffect(() => {
    if (fill.status !== 'loading' || fetchOlder !== undefined) return
    setFill({ status: 'failed', cursor: fill.cursor })
  }, [fill, fetchOlder])
  useEffect(() => {
    if (fill.status !== 'loading' || fetchOlder === undefined) return
    const cursor = fill.cursor
    let live = true
    const timer = setTimeout(() => {
      void fetchOlder(cursor).then(
        (result) => {
          if (!live) return
          if (result === null) {
            setFill({ status: 'failed', cursor })
            return
          }
          if (result.commands.length > 0) setKnown(prev => knownWithPage(prev, result.commands))
          let oldest = cursor
          for (const rec of result.commands) if (rec.seq < oldest) oldest = rec.seq
          if (result.atStart) {
            setFill({ status: 'done' })
            return
          }
          if (oldest >= cursor) {
            setFill({ status: 'failed', cursor })
            return
          }
          cursorTarget.current = oldest
          setFill({ status: 'loading', cursor: oldest, total: result.total })
        },
        () => { if (live) setFill({ status: 'failed', cursor }) },
      )
    }, PAGE_PAUSE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [fill, fetchOlder])
  const retry = useCallback(() => {
    setFill({ status: 'loading', cursor: cursorTarget.current })
  }, [])
  return {
    records,
    status: fill.status,
    ...(fill.status === 'loading' && fill.total !== undefined ? { total: fill.total } : {}),
    retry,
  }
}
