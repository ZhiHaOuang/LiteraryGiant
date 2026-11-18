import { PROCESS_COLUMN_ATTR } from '../../constants'

/**
 * Draws an open process group's rows as one card (process-column.css). The
 * feature runs only while the column layout is chosen, so the attribute the
 * stylesheet reads comes off with it and the flat layout is the host's own.
 */
export function install() {
  document.body.setAttribute(PROCESS_COLUMN_ATTR, '')
  return () => {
    document.body.removeAttribute(PROCESS_COLUMN_ATTR)
  }
}
