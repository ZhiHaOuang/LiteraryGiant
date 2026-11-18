import { useLayoutEffect, type RefObject } from 'react'

export type ConversationSurfaceKind = 'pane' | 'modal'

interface SurfaceMark {
  readonly marks: WeakMap<Element, { count: number }>
  readonly attr: string
}

const SURFACES: Record<ConversationSurfaceKind, SurfaceMark> = {
  pane: { marks: new WeakMap(), attr: 'data-lc-surface' },
  modal: { marks: new WeakMap(), attr: 'data-lc-modal' },
}

export function useConversationSurface(ref: RefObject<HTMLElement | null>, kind: ConversationSurfaceKind = 'pane'): void {
  const surface = SURFACES[kind]
  useLayoutEffect(() => {
    const scroller = ref.current?.closest<HTMLElement>('[data-conversation-scroll]')
    if (scroller === null || scroller === undefined) return undefined
    let mark = surface.marks.get(scroller)
    if (mark === undefined) {
      mark = { count: 0 }
      surface.marks.set(scroller, mark)
    }
    mark.count++
    scroller.setAttribute(surface.attr, '')
    return () => {
      mark.count--
      if (mark.count > 0) return
      surface.marks.delete(scroller)
      scroller.removeAttribute(surface.attr)
    }
  }, [ref, surface])
}
