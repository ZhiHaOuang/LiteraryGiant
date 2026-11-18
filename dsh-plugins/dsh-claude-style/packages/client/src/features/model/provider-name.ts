import { MODEL_ACCOUNT_GROUP } from './model-labels'
import { copy } from './copy'

/**
 * The name one provider group reads as. The account route carries the host's
 * own English display name; the shell's language supplies the localized words,
 * the way the host's model picker names it.
 *
 * @param id - the provider group's id.
 * @param name - the catalog's display name, when it has one.
 */
export function modelGroupName(id: string, name?: string): string {
  if (id === MODEL_ACCOUNT_GROUP) return copy('accountLabel')
  return name || id
}
