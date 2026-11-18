import type { ContextSettings } from './settings'

export function watchGate(
  store: ContextSettings['store'],
  wanted: () => boolean,
  mount: () => readonly unknown[],
): () => void {
  let mounted = false
  let disposers: (() => void)[] = []
  const unmount = (): void => {
    while (disposers.length > 0) disposers.pop()?.()
  }
  const apply = (): void => {
    const want = wanted()
    if (want && !mounted) {
      mounted = true
      disposers = mount().filter((handle): handle is () => void => typeof handle === 'function')
    } else if (!want && mounted) {
      mounted = false
      unmount()
    }
  }
  apply()
  const unsubscribe = store.subscribe(apply)
  return () => {
    unsubscribe()
    if (mounted) {
      mounted = false
      unmount()
    }
  }
}
