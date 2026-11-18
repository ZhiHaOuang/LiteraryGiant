import type { HostModelEntry } from '@dsh-claude-style/contracts/services'

/**
 * The release tag the host draws for one official model. The host's own label
 * plugin (`dsh-client-ui-deepseek-model-label-1017`) renders "1017" beside the
 * official providers' Flash entry, and its catalog carries no such field, so the
 * rule is copied here until the host offers it as data. The plugin also matches
 * the display name; this rule keys on the provider and model ids alone, so a
 * host that renames the model keeps the tag until this rule is updated with it.
 *
 * @param provider - the provider group's id.
 * @param model - the catalog entry.
 * @returns the tag's words, or null when the model carries none.
 */
export function releaseTag(provider: string, model: HostModelEntry): string | null {
  if (provider !== 'deepseek-official' && provider !== 'deepseek-account') return null
  return model.id === 'deepseek-flash' ? '1017' : null
}
