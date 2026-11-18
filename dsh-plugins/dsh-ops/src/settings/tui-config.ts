import { resolveActivityConfig } from '../tui/activity.js'
import { configObject, editable, settingsConfig } from './schema.js'
export const Config = settingsConfig(value => resolveActivityConfig(configObject(value)), {
  maxSessions: editable('number', 'Maximum retained sessions (1–256).'),
  maxActive: editable('number', 'Maximum active records (1–1024).'),
  recentLimit: editable('number', 'Maximum recent records per session (1–64).'),
})
