import COPY from './settings.copy.json'
import { createCopy, featureCopy } from '../../core/i18n'
import type { CopyParams } from '../../core/i18n'

export type CopyKey = keyof typeof COPY

/**
 * One line of this feature's own interface copy, in the shell's language
 * (packages/client/src/features/settings/settings.copy.json): the copy ships with the
 * bundle, so the first paint carries it and a key is this file's own.
 */
export const copy = createCopy(COPY)

/**
 * A line two features' settings rows share, kept in this page's own copy (D72):
 * the note a row shows while the composer restyle is off, and the line a row
 * acting on the Windows desktop window alone shows on every other page.
 */
export function sharedLine(key: string, params?: CopyParams) {
  return featureCopy(COPY, key, params)
}
