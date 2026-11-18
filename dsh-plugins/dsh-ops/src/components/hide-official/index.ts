import { apply, resolveHidingConfig } from '../../official-tool-hiding.js'
import { editable, settingsConfig, configObject } from '../../settings/schema.js'
export const name = 'dsh-ops-hide-official'
export { apply }
export const Config = settingsConfig(value => resolveHidingConfig(configObject(value)), {
  replaceTools: editable('array', 'Official read/search tools explicitly selected for replacement.', { type: 'string' }),
})
