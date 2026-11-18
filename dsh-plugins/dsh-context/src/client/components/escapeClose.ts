import { useEffect, useRef } from 'react'
import { isBareEscape, isClearableField, ownsClearEscape } from './clearableInput'

export function useEscapeClose(active: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (ev: KeyboardEvent): void => {
      if (!isBareEscape(ev)) return
      const target = ev.target
      if (isClearableField(target) && (ev.isComposing || ownsClearEscape(target))) {
        if (ev.isComposing) ev.stopPropagation()
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active])
}
