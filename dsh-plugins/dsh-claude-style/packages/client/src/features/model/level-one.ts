import { ACCOUNT_MODEL_GROUP, OFFICIAL_MODEL_GROUP } from '@dsh-claude-style/contracts/services'
import type { HostModelGroup } from '@dsh-claude-style/contracts/services'

/**
 * The provider groups the model picker's first level carries.
 *
 * The API-key route keeps the lead whenever it advertises models. Without its
 * key the host answers that route with an empty catalog, and the signed-in
 * account takes the lead instead. Quick providers follow, and a catalog with
 * neither default falls back to the chosen providers, then to every provider.
 *
 * @param groups - the catalog's provider groups, in catalog order.
 * @param chosen - the quick-provider ids the settings page stored.
 */
export function levelOneSections(groups: HostModelGroup[], chosen: readonly string[]): HostModelGroup[] {
  const sections: HostModelGroup[] = []
  const lead = leadingGroup(groups)
  if (lead !== null) sections.push(lead)
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]
    if (group.models.length === 0) continue
    if (group.id === OFFICIAL_MODEL_GROUP || (lead !== null && group.id === lead.id)) continue
    if (!chosen.includes(group.id)) continue
    sections.push(group)
  }
  if (sections.length === 0) {
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].models.length > 0) sections.push(groups[g])
    }
  }
  return sections
}

/**
 * The group that leads the first level: the API-key route while it has models,
 * and the account route when that route has none.
 */
function leadingGroup(groups: HostModelGroup[]): HostModelGroup | null {
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].id === OFFICIAL_MODEL_GROUP && groups[g].models.length > 0) return groups[g]
  }
  for (let g = 0; g < groups.length; g++) {
    if (groups[g].id === ACCOUNT_MODEL_GROUP && groups[g].models.length > 0) return groups[g]
  }
  return null
}
