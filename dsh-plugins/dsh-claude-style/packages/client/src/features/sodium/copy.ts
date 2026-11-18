import COPY from './sodium.copy.json'
import { createCopy } from '../../core/i18n'

export type CopyKey = keyof typeof COPY

/** One line of this feature's own interface copy, in the shell's language (sodium.copy.json). */
export const copy = createCopy(COPY)
