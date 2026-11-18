import COPY from './context-stats.copy.json'
import { createCopy } from '../../core/i18n'

export type CopyKey = keyof typeof COPY

/**
 * One line of this feature's own interface copy, in the shell's language
 * (packages/client/src/features/context-stats/context-stats.copy.json): the copy ships with the
 * bundle, so the first paint carries it and a key is this file's own.
 */
export const copy = createCopy(COPY)
