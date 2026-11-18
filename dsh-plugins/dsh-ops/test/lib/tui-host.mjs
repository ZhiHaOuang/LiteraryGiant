/** Shared real TUI test imports. Import only after checking suite-specific prerequisites. */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEST_HOME, skipSuite } from './harness.mjs'

const target = process.env.DSH_OPS_TUI_ROOT
if (!target) {
  if (process.env.DSH_OPS_REQUIRE_TUI === '1') throw new Error('DSH_OPS_TUI_ROOT is required for real TUI acceptance.')
  skipSuite('TUI host', 'set DSH_OPS_TUI_ROOT to a dsh-TUI checkout or built package')
}
// Preferences and ledger paths are fixed at import time. Never use a user HOME.
process.env.HOME = TEST_HOME
process.env.USERPROFILE = TEST_HOME
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const rootPath = resolve(target)
export const tuiRequire = createRequire(join(rootPath, 'package.json'))
export const runtimeModule = name => import(pathToFileURL(tuiRequire.resolve(name)).href)
const source = process.env.DSH_OPS_TUI_BUILT !== '1' && existsSync(join(rootPath, 'src', 'dsh-adapter', 'panels.ts'))
export let unregister
if (source) {
  const { register } = await runtimeModule('tsx/esm/api')
  unregister = register()
}
const hostModule = file => import(pathToFileURL(join(rootPath, source ? 'src' : 'lib/types', file + (source ? '.ts' : '.js'))).href)
export const { Context } = await runtimeModule('@deepseek-ai/cordis')
export const { default: Loader } = await runtimeModule('@deepseek-ai/cordis-plugin-loader')
export const { default: React } = await runtimeModule('react')
export const { Terminal } = (await runtimeModule('@xterm/headless')).default
export const hostRow = await hostModule('dsh-adapter/plugin-host')
export const { TuiPanelRuntime } = await hostModule('dsh-adapter/panels')
export const { armAdmissionLoader } = await hostModule('dsh-adapter/admission-loader')
export const { panelStore } = await hostModule('components/sidePanel/PanelStore')
export const { PanelHost } = await import(pathToFileURL(join(rootPath, source ? 'src/components/sidePanel/PanelHost.tsx' : 'lib/types/components/sidePanel/PanelHost.js')).href)
export const ui = await hostModule('ui')
export const { setLang } = await hostModule('i18n')
setLang('en')

/** Test driver for the public, focus-gated panel input runtime. */
export function createInputRuntime() {
  const handlers = new Map()
  return {
    registerInput(panelId, handler, enabled) {
      const entry = { handler, enabled }; handlers.set(panelId, entry)
      return () => { if (handlers.get(panelId) === entry) handlers.delete(panelId) }
    },
    dispatchKey(panelId, input, key = {}) {
      const entry = handlers.get(panelId)
      return entry?.enabled ? entry.handler(input, key) : false
    },
    isEnabled: panelId => handlers.get(panelId)?.enabled === true,
    size: () => handlers.size,
  }
}
