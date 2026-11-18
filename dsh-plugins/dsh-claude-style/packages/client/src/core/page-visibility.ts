import { ASLEEP_ATTR } from '../constants'
import { notifyAll } from '@dsh-claude-style/engine/notify'

/**
 * The page's visibility (D40): the browser's own answer has one owner, because
 * the stylesheet and the clocks in script both act on it. A page is off screen
 * when the window is hidden or another application covers it — not when it
 * merely lost the focus and stands beside the one that has it.
 *
 * While the page is off screen the document wears ASLEEP_ATTR and the sheet
 * holds every animation still (theme/chrome.css). A compositor animation left
 * running keeps producing frames for a window nobody sees, and those frames are
 * what the page has to catch up on the moment the reader comes back.
 */
const listeners: ((hidden: boolean) => void)[] = []

/** Whether the page is off screen right now. */
export function pageHidden() {
  return document.visibilityState === 'hidden'
}

/** Observe the page leaving the screen and coming back; returns the unsubscriber. */
export function subscribePageHidden(listener: (hidden: boolean) => void) {
  listeners.push(listener)
  return () => {
    const index = listeners.indexOf(listener)
    if (index !== -1) listeners.splice(index, 1)
  }
}

/**
 * Mirror the answer onto the document and tell what waits on it. Installed with
 * the sheet and taken off by release(), so the mark belongs to the generation
 * that owns the page (D74).
 *
 * @returns the stop that takes the listener and the mark away.
 */
export function installPageVisibility() {
  let hidden = pageHidden()
  writeMark(hidden)
  const onVisibilityChange = () => {
    const next = pageHidden()
    if (next === hidden) return
    hidden = next
    writeMark(hidden)
    notifyAll(listeners, hidden)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.body.removeAttribute(ASLEEP_ATTR)
  }
}

function writeMark(hidden: boolean) {
  if (hidden) document.body.setAttribute(ASLEEP_ATTR, '')
  else document.body.removeAttribute(ASLEEP_ATTR)
}
