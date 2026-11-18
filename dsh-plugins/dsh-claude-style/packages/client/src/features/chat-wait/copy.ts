import COPY from './chat-wait.copy.json'
import { createCopy, featureCopy } from '../../core/i18n'
import type { CopyParams } from '../../core/i18n'

export type CopyKey = keyof typeof COPY

/**
 * One line of this feature's own interface copy, in the shell's language
 * (packages/client/src/features/chat-wait/chat-wait.copy.json): the copy ships with the
 * bundle, so the first paint carries it and a key is this file's own.
 */
export const copy = createCopy(COPY)

/**
 * The words for one state the shared state machine named (shared/turn-activity):
 * its keys are this file's own, but the state carries the key as a plain string
 * because the shared layer does not know this feature's copy. A key this file
 * does not carry stands as written, which is how a stale table shows up.
 */
export function copyState(key: string, params?: CopyParams) {
  return featureCopy(COPY, key, params)
}
