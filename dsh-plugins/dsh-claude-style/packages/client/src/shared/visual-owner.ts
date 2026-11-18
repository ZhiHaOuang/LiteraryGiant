import { DS_BOT_SURFACE_ATTRIBUTE } from '@dsh-claude-style/contracts/dom'
import { SKIN_STAMP_ATTR } from '../constants'
import { subscribeMutations } from '@dsh-claude-style/engine/bus'

/**
 * Who has this page instead of the theme (D74): a skin, or ds-bot's Bot
 * surface. Null leaves the page to the theme.
 *
 * The skin center stamps `html[data-dsh-skin]` while a skin is painting, and
 * injects it into the served document, so that answer holds from the first
 * frame. It does not stamp its attribute for this theme's own row: selecting
 * this theme means the page has no skin on it, which is what leaves the page
 * free for the theme to take. A wallpaper plugin is not an owner: it paints
 * behind the shell, and the theme shares the page with it.
 *
 * ds-bot paints its whole Bot surface over the shell and withdraws it for the
 * shell's own interface in its Agent mode; its shell group marks `<body>`
 * while it is painted. Its browser half runs after this theme's, so until its
 * registry is on `window` the mode it saved answers instead, and a page that
 * reopens on the Bot surface never shows the theme first.
 */
export type PageOwner = 'skin' | 'ds-bot'

/** ds-bot's id in the host's boot entry list. */
const DS_BOT_ENTRY_ID = 'ds-bot'
/** The local storage key ds-bot keeps its mode under: `agent`, or the Bot surface otherwise. */
const DS_BOT_MODE_KEY = 'ds-bot:surface'
const DS_BOT_AGENT_MODE = 'agent'

/** The boot list's answer, read once: the list is fixed at load. */
let dsBotEntry: boolean | null = null

/** Whether ds-bot is one of this page's client entries. */
export function dsBotInstalled() {
  if (dsBotEntry === null) {
    const entries = window.__DSH_BOOT__?.entries
    dsBotEntry = Array.isArray(entries) && entries.some(entry => entry?.id === DS_BOT_ENTRY_ID)
  }
  return dsBotEntry
}

/** Whether ds-bot's Bot surface has the page, or will have it once ds-bot's browser half runs. */
export function dsBotSurfaceActive() {
  if (!dsBotInstalled()) return false
  if (document.body.hasAttribute(DS_BOT_SURFACE_ATTRIBUTE)) return true
  if (window.dshBot !== undefined) return false
  return localStorage.getItem(DS_BOT_MODE_KEY) !== DS_BOT_AGENT_MODE
}

/** The page's owner right now; null while the theme has it. */
export function pageOwner(): PageOwner | null {
  if (document.documentElement.hasAttribute(SKIN_STAMP_ATTR)) return 'skin'
  if (dsBotSurfaceActive()) return 'ds-bot'
  return null
}

/**
 * Watch both owners' marks, and hear when the page's owner changes.
 *
 * The attributes are read; nothing is written. The callback fires only on a
 * real change: the caller reads `pageOwner()` itself at boot.
 *
 * @param listener - called with the new owner.
 * @returns unsubscribe.
 */
export function subscribePageOwner(listener: (owner: PageOwner | null) => void) {
  let last = pageOwner()
  const check = () => {
    const next = pageOwner()
    if (next === last) return
    last = next
    listener(next)
  }
  const offSkin = subscribeMutations(document.documentElement, { attributeFilter: [SKIN_STAMP_ATTR] }, check)
  const offBot = subscribeMutations(document.body, { attributeFilter: [DS_BOT_SURFACE_ATTRIBUTE] }, check)
  return () => {
    offSkin()
    offBot()
  }
}
