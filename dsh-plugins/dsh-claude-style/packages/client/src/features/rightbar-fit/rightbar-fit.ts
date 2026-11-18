import { RIGHTBAR_COLUMN_SELECTOR, RIGHTBAR_HANDLE_SELECTOR, RIGHTBAR_PANEL_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { observeMatches, subscribeMutations } from '@dsh-claude-style/engine/bus'
import { cacheFirstMatch } from '@dsh-claude-style/engine/host'
import { PAGE_ZOOM_ATTR } from '../../constants'
import { heldWrites } from '../../shared/held-writes'
import { pageZoomFactor } from '../../shared/page-zoom'

/**
 * The right column's own box, in the page's pixels.
 *
 * The host states the panel's width from the viewport's pixels and places the
 * drag handle from the same measurement, while the page's zoom scales both a
 * second time: the panel stands wider than the track the frame gives it and
 * covers the centre, and the handle leaves the edge it exists to drag. The
 * frame's own columns are carried by the page-scale module; these two
 * declarations are rewritten here, each on the write the host makes, and a page
 * at scale 1 keeps the host's numbers.
 */

/** Trim a computed page length to the shape a CSS declaration keeps. */
function length(value: number) {
  return `${Math.round(value * 100) / 100}px`
}

export function install() {
  const writes = heldWrites()
  let panel: HTMLElement | null = null
  let handle: HTMLElement | null = null
  /** The subscriptions hearing the two elements standing right now. */
  const heard: (() => void)[] = []
  let queued = false

  function fixPanel(factor: number) {
    if (panel === null) return
    const current = panel.style.getPropertyValue('width').trim()
    if (!current.endsWith('px')) return
    const raw = writes.hostValue(panel, 'width', current)
    const width = Number.parseFloat(raw)
    if (!Number.isFinite(width)) return
    // The column the grid gives this panel is its ceiling: a panel wider than
    // its own track stands over the centre, and a track narrowed to nothing
    // leaves the panel with no room to stand in at all. A column that has not
    // been given a width yet (the panel mounts before the grid expands) says
    // nothing, so the host's own value stands until the track is there.
    const track = column()
    const limit = track === null || track.clientWidth <= 0 ? Number.POSITIVE_INFINITY : track.clientWidth
    const page = length(Math.min(width / factor, limit))
    writes.write(panel, 'width', raw, page)
    // The panel carries its width twice, and the second declaration states its
    // own number: it is read from itself rather than from the width.
    const sidebar = panel.style.getPropertyValue('--dsh-sidebar-width').trim()
    if (sidebar.endsWith('px')) {
      writes.write(panel, '--dsh-sidebar-width', writes.hostValue(panel, '--dsh-sidebar-width', sidebar), page)
    }
  }

  function fixHandle(factor: number) {
    if (handle === null || panel === null) return
    const current = handle.style.getPropertyValue('left').trim()
    if (!current.endsWith('px')) return
    const raw = writes.hostValue(handle, 'left', current)
    const left = Number.parseFloat(raw)
    if (!Number.isFinite(left)) return
    // The handle sits on the panel's visible left edge, which is the width the
    // panel actually took rather than the one the host wrote for it.
    const page = length(document.documentElement.clientWidth / factor - panel.offsetWidth)
    writes.write(handle, 'left', raw, page)
  }

  function sync() {
    queued = false
    const nextPanel = panels.all()[0] ?? null
    const nextHandle = handles.all()[0] ?? null
    if (nextPanel !== panel || nextHandle !== handle) {
      for (const stop of heard.splice(0)) stop()
      panel = nextPanel
      handle = nextHandle
      for (const element of [panel, handle]) {
        if (element !== null) heard.push(subscribeMutations(element, { attributes: true, attributeFilter: ['style'] }, schedule))
      }
    }
    const factor = pageZoomFactor()
    if (factor === 1) {
      writes.restore()
      return
    }
    fixPanel(factor)
    fixHandle(factor)
  }

  function schedule() {
    if (queued) return
    queued = true
    // A microtask keeps the rewrite ahead of the frame the host's write would paint.
    queueMicrotask(sync)
  }

  // The panel and the handle mount inside the frame, where the body's own child
  // list does not reach; the bus's kept matches hear them arrive and leave.
  const panels = observeMatches<HTMLElement>(RIGHTBAR_PANEL_SELECTOR, schedule)
  const handles = observeMatches<HTMLElement>(RIGHTBAR_HANDLE_SELECTOR, schedule)
  const column = cacheFirstMatch<HTMLElement>(RIGHTBAR_COLUMN_SELECTOR)
  // The factor rides an attribute on the body, so a change of zoom re-derives both.
  const stopZoom = subscribeMutations(document.body, { attributes: true, attributeFilter: [PAGE_ZOOM_ATTR] }, schedule)

  schedule()

  return () => {
    stopZoom()
    panels.release()
    handles.release()
    for (const stop of heard.splice(0)) stop()
    writes.restore()
  }
}
