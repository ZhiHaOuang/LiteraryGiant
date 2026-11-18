import { useCallback, useEffect, useState } from 'react'

const IDLE_TIMEOUT_MS = 200

export function useLazyMount(force = false): [(el: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLElement | null) => { setNode(el) }, [])
  const [mounted, setMounted] = useState(() => force || typeof IntersectionObserver !== 'function')
  useEffect(() => {
    if (mounted) return
    if (force) {
      setMounted(true)
      return
    }
    if (node === null) return
    /* v8 ignore start */
    let idle = 0
    const reveal = (): void => {
      if (typeof requestIdleCallback === 'function') {
        idle = requestIdleCallback(() => { setMounted(true) }, { timeout: IDLE_TIMEOUT_MS })
      } else {
        idle = window.setTimeout(() => { setMounted(true) }, 0)
      }
    }
    const root = node.closest('[data-conversation-scroll]')
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect()
        reveal()
      }
    }, { root: root instanceof Element ? root : null, rootMargin: '200px' })
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (idle !== 0) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
        else clearTimeout(idle)
      }
    }
    /* v8 ignore stop */
  }, [node, mounted, force])
  return [ref, mounted]
}
