import COPY from './ban-screen.copy.json'
import { copyIn } from '../../core/i18n'
import { readPrefs } from '../../core/prefs'
import type { CopyParams } from '../../core/i18n'

/** One key of the hold screen's own copy. */
export type CopyKey = keyof typeof COPY

/**
 * One line of the hold screen's copy, in the language the `banLocale`
 * preference names — NOT the shell's language. The page reproduces a real
 * Claude screen, so it is read in the language that page was written in,
 * whatever the rest of the UI is set to (the preference's own reason is in the
 * contract's table, packages/contracts/src/prefs.ts).
 */
export function copy(key: CopyKey, params?: CopyParams) {
  return copyIn(COPY, key, readPrefs().banLocale, params)
}
