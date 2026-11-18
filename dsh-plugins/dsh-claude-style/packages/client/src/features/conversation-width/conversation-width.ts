import { CONVERSATION_WIDTH_ATTR } from '../../constants'
import { readPrefs, subscribePrefs } from '../../core/prefs'

/**
 * Draws the conversation column at the factor the reader picked
 * (conversation-width.css). The feature runs only while a factor below the
 * full width is chosen, so the attribute carrying the factor comes off with it.
 *
 * The host's width handles keep writing the full-width figure: a drag moves the
 * column edge by the factor's share of the pointer's travel.
 */
export function install() {
  function write() {
    document.body.setAttribute(CONVERSATION_WIDTH_ATTR, readPrefs().conversationWidth)
  }

  write()
  const stop = subscribePrefs(write)

  return () => {
    stop()
    document.body.removeAttribute(CONVERSATION_WIDTH_ATTR)
  }
}
