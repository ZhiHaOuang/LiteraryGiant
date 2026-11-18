import { useEffect, useState, type ReactNode } from 'react'
import type { Translate } from '../i18n'

export type FetchMissState = 'idle' | 'loading' | 'absent' | 'failed'

export interface FetchOnMiss<T> {
  values: Map<number, T>
  state: FetchMissState
  retry: () => void
}

export function useFetchOnMiss<T>(
  key: number | null,
  fetcher: ((key: number) => Promise<T | null>) | undefined,
  warn: string,
): FetchOnMiss<T> {
  const [values, setValues] = useState<Map<number, T>>(() => new Map())
  const [state, setState] = useState<FetchMissState>('idle')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (key === null || fetcher === undefined || values.has(key)) return
    let live = true
    setState('loading')
    fetcher(key).then((value) => {
      if (!live) return
      if (value === null) {
        setState('absent')
        return
      }
      setValues((prev) => {
        const next = new Map(prev)
        next.set(key, value)
        return next
      })
      setState('idle')
    }, (error: unknown) => {
      console.warn(warn, error)
      if (live) setState('failed')
    })
    return () => { live = false }
  }, [key, fetcher, attempt, values])
  return { values, state, retry: () => { setAttempt(a => a + 1) } }
}

export function fetchMissNote(
  t: Translate,
  fetcher: unknown,
  state: FetchMissState,
  onRetry: () => void,
  emptyKey: 'browser.noContent' | 'browser.headerMetaOnly',
): ReactNode {
  if (fetcher === undefined) return t(emptyKey)
  if (state === 'absent') return t('browser.notInLog')
  if (state === 'failed') {
    return (
      <button type="button" className="lc-br-retry hover:brightness-[1.15]" onClick={onRetry}>
        {t('browser.loadFailed')}
      </button>
    )
  }
  return t('browser.loading')
}
