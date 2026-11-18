import { hostCtx } from './host-context'
import type { HostContext, HostText } from '@dsh-claude-style/engine/host'

/** Values for a copy string's `{name}` slots. */
export type CopyParams = Record<string, string | number>

/** One copy line: the text in each language it ships in. */
export type CopyPair = Readonly<Record<string, string>>

/** A feature's own copy, by key (its `<功能>.copy.json`). */
export type CopyEntries = Readonly<Record<string, CopyPair>>

/**
 * The language a copy line falls back to when the shell's own language has no
 * line for it. A feature's copy ships with the bundle, so every line is written
 * in this language as well (`<功能>.copy.json` beside the feature).
 */
export const COPY_FALLBACK_LOCALE = 'en'

/**
 * The shell's active locale id, or the language the copy ships in when it cannot
 * be read: a host with no locale service, a service without `getSnapshot`, or a
 * snapshot that says nothing are all the same answer here (D12 — the copy ships
 * in its own language rather than the page throwing).
 */
export function activeLocale(ctx?: HostContext | null): string {
  const locale = (ctx || hostCtx)?.get('locale')
  const snapshot = typeof locale?.getSnapshot === 'function' ? locale.getSnapshot() : undefined
  const active = snapshot?.active
  if (typeof active === 'string' && active) return active
  return COPY_FALLBACK_LOCALE
}

/**
 * The host's `chat` namespace translate seat, or null where the host carries no
 * locale service. A surface with no context of its own — the settings page —
 * reads the host's words through the module's context (core/host).
 */
export function hostChatSeat(ctx?: HostContext | null): HostText | null {
  const locale = (ctx || hostCtx)?.get('locale')
  return typeof locale?.bind === 'function' ? locale.bind('chat') : null
}

/**
 * One string out of the host's own `chat` namespace, or `fallback` where the
 * host carries no locale service or no such string: a seat that hands the key
 * back has no translation for it.
 */
export function hostChatCopy(key: string, fallback: string, ctx?: HostContext | null) {
  const text = hostChatSeat(ctx)?.(key)
  return typeof text === 'string' && text !== '' && text !== key ? text : fallback
}

/** Fill a copy string's `{name}` slots from `params`; a slot with no value stays as written. */
function fillTemplate(text: string, params?: CopyParams) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

/**
 * One localized string out of a `{ locale: text }` pair, fallback locale last:
 * the language the copy ships in, or the one a data document names (the model
 * copy's own `fallback`).
 */
export function localized(pair: Record<string, unknown> | null | undefined, ctx?: HostContext | null, fallback: string = COPY_FALLBACK_LOCALE) {
  if (!pair || typeof pair !== 'object') return ''
  const loc = activeLocale(ctx)
  const text = pair[loc]
  if (typeof text === 'string' && text) return text
  const prefix = typeof loc === 'string' && loc.includes('-') ? loc.split('-')[0] : (typeof loc === 'string' && loc.includes('_') ? loc.split('_')[0] : '')
  const prefixed = pair[prefix]
  if (prefix && typeof prefixed === 'string' && prefixed) return prefixed
  const backstop = pair[fallback]
  if (typeof backstop === 'string' && backstop) return backstop
  const fallbackPrefix = typeof fallback === 'string' && fallback.includes('-') ? fallback.split('-')[0] : ''
  const fallbackPrefixed = pair[fallbackPrefix]
  if (fallbackPrefix && typeof fallbackPrefixed === 'string' && fallbackPrefixed) return fallbackPrefixed
  return ''
}

/**
 * One line of a feature's own copy: the shell's language first, then the
 * language the copy ships in. The key is the feature's own — its copy file is
 * the only place the line exists — and the build holds every call to one, so a
 * line that is not there is a build failure rather than a runtime question.
 */
export function featureCopy(entries: CopyEntries, key: string, params?: CopyParams) {
  const pair = entries[key]
  return fillTemplate(pair === undefined ? key : localized(pair), params)
}

/**
 * A feature's own `copy` function over its copy document: the type keeps the
 * keys that document carries, so a misspelt line fails the build instead of
 * reading as its own key on the page.
 */
export function createCopy<C extends CopyEntries>(entries: C) {
  return (key: keyof C & string, params?: CopyParams) => featureCopy(entries, key, params)
}

/**
 * One line of a feature's copy in a language named by a preference rather than
 * by the shell: the account-hold screen reproduces a real Claude page, so it is
 * read in the language that page was written in whatever the UI is set to.
 */
export function copyIn(entries: CopyEntries, key: string, locale: string, params?: CopyParams) {
  const pair = entries[key]
  const text = pair === undefined ? '' : (pair[locale] || pair[COPY_FALLBACK_LOCALE] || '')
  return fillTemplate(text === '' ? key : text, params)
}
