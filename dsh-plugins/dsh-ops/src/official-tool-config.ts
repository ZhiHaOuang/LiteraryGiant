/** Explicit reviewed replacements. Legacy blanket settings are validated but inert. */
import { ConfigError } from './config-error.js'
import { OFFICIAL_REPLACEMENTS } from './official-tool-catalog.js'
import type { OfficialReplacement } from './official-tool-catalog.js'
export interface HidingConfig { replaceTools: OfficialReplacement[] }
export function resolveHidingConfig(raw: unknown = {}): HidingConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('hiding config must be an object')
  const input = raw as Record<string, unknown>
  const keys = ['replaceTools', 'strict', 'scope', 'additionalOfficialTools']
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new ConfigError(`unknown hiding key: ${key}`)
  // Saved 0.3 rows must not regain blanket hiding after an update.
  if (input.strict !== undefined && input.strict !== true) throw new ConfigError('strict is a legacy key and must be true when present')
  if (input.scope != null && (typeof input.scope !== 'string' || !['takeover', 'extended', 'off'].includes(input.scope))) {
    throw new ConfigError('scope is a legacy key and must be takeover, extended or off')
  }
  const aliases = input.additionalOfficialTools ?? []
  if (!Array.isArray(aliases) || aliases.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n) || n.startsWith('ops_'))) {
    throw new ConfigError('additionalOfficialTools must be an array of official tool names (not ops_* replacements)')
  }
  const selected = input.replaceTools === undefined ? [] : input.replaceTools
  if (!Array.isArray(selected)) throw new ConfigError('replaceTools must be an array of reviewed official tool names')
  const replaceTools: OfficialReplacement[] = []
  for (const tool of selected) {
    if (typeof tool !== 'string' || !Object.hasOwn(OFFICIAL_REPLACEMENTS, tool)) {
      throw new ConfigError(`replaceTools contains unsupported tool: ${JSON.stringify(tool)}; choose read, glob or grep`)
    }
    replaceTools.push(tool as OfficialReplacement)
  }
  return { replaceTools: [...new Set(replaceTools)] }
}
