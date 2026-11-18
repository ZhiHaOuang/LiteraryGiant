/**
 * The settings surface: the preferences schema the host's settings domain
 * derives its form from, and the registration that hands it over.
 *
 * The host derives every settings form from the profile entry's Config and
 * exposes only the fields marked `.volatile()`; the schema resolution is
 * defensive because a `link:`-installed plugin resolves its realpath outside
 * the profile tree (see resolveSchemaFactory). A host that cannot resolve the
 * package still loads the skin — it just loses the settings form.
 *
 * The preference list itself is the shared table, so both halves declare the
 * fields from one declaration (`@dsh-claude-style/contracts/prefs`, D73).
 */
import { PACKAGE_NAME } from '@dsh-claude-style/contracts/package'
import { PREFS } from '@dsh-claude-style/contracts/prefs'
import type { PrefKey } from '@dsh-claude-style/contracts/prefs'
import type { DshContext, DshScope } from '@dsh-claude-style/engine/node/dsh'

/**
 * The schemastery instance the HARNESS itself resolves.
 *
 * A plugin installed by link (`link:D:/…`) resolves its realpath outside the
 * profile tree, so Node never walks the profile's `node_modules` and the plain
 * import fails outright — and the copy the profile's interception layer would
 * offer can belong to a DIFFERENT installation (the Desktop bundle's 3.18.2,
 * which has no `.volatile()`). The harness always carries schemastery beside
 * its own bin, and that copy is the instance the settings domain validates
 * forms against, so it is asked for first; normal resolution stays as the
 * fallback for a plainly installed plugin.
 *
 * @returns the schema factory, or null when neither path resolves.
 */
async function resolveSchemaFactory(): Promise<SchemaFactory | null> {
  try {
    const { createRequire } = await import('node:module')
    const anchor = typeof process.argv[1] === 'string' && process.argv[1] !== '' ? process.argv[1] : process.execPath
    const factory = createRequire(anchor)('@deepseek-ai/schemastery')
    if (factory !== null && factory !== undefined && typeof factory.object === 'function') return factory as SchemaFactory
  } catch { /* the anchor carries no schemastery: try normal resolution */ }
  try {
    // The specifier stays a value: the module is optional, so neither the type
    // check nor the build may require it to be installed.
    const specifier = '@deepseek-ai/schemastery'
    const resolved = await import(specifier)
    const factory = resolved?.default ?? resolved?.Schema ?? null
    return factory !== null && factory !== undefined && typeof factory.object === 'function' ? factory as SchemaFactory : null
  } catch {
    return null
  }
}

/**
 * The schema factory the host provides (`@deepseek-ai/schemastery`), as far as
 * this half uses it: it is resolved at runtime and may be absent (D75), so the
 * shape is declared here rather than imported.
 */
interface SchemaFactory {
  object(fields: Record<string, unknown>): unknown
  string(): SchemaField
  boolean(): SchemaField
  union(items: unknown[]): SchemaField
  array(item: unknown): SchemaField
}

/** One schema field: its default, and the `volatile()` marker when the factory has it. */
interface SchemaField {
  default(value: unknown): SchemaField
  volatile?(): SchemaField
}

const SchemaFactory = await resolveSchemaFactory()

/** Mark one field editable by the settings page, where the factory supports it. */
function volatileField(field: SchemaField | null | undefined) {
  return typeof field?.volatile === 'function' ? field.volatile() : field
}

/**
 * One Config field for one preference, permissive on purpose: it takes the
 * shapes a stored value may have carried — a string, a boolean or an array of
 * strings — and keeps the table's default (packages/contracts/src/prefs.ts,
 * D73). A value an older build stored (`autoPopover` was a boolean,
 * `chatAnimations` held a choice) therefore never fails the host's own
 * validation and never keeps the package from starting: the host checks a
 * profile entry's config against this Config before it starts the plugin, and a
 * refused value starts nothing of this package at all. The browser half clamps
 * what it reads and falls back to the default (packages/client/src/core/prefs.ts).
 */
function prefsField(Schema: SchemaFactory, key: PrefKey) {
  return Schema
    .union([Schema.string(), Schema.boolean(), Schema.array(Schema.string())])
    .default(PREFS[key].default)
}

/**
 * The declared Config.
 *
 * The host derives every settings form from the profile entry's Config and
 * exposes only the fields marked `.volatile()`, so the preferences are
 * declared here. schemastery grew `volatile()` in 3.18.3 and the desktop
 * bundle ships 3.18.2, so the marker is applied only when the installed
 * factory provides it.
 *
 * The import is guarded and top-level-awaited (D75): a
 * host that cannot resolve schemastery must still load the skin — it just
 * loses the settings form.
 *
 * Field types stay permissive on purpose: the accepted sets are enforced where
 * they are consumed — the browser half clamps everything it reads and falls
 * back to the shipped default — so a set declared here would only narrow what a
 * stored value may keep, and a value the Config refuses keeps the host from
 * starting this package at all (prefsField above).
 */
export const Config = SchemaFactory === null
  ? undefined
  : SchemaFactory.object(Object.fromEntries(
      Object.keys(PREFS).map(key => [key, volatileField(prefsField(SchemaFactory, key as PrefKey))]),
    ))

/**
 * Register the settings surface: the skin ships its own settings page, which
 * is what `configure({ auto: false })` says — without it a client that
 * projects pages from the schema would grow a second page beside ours.
 *
 * The wait is declarative (`ctx.inject`) because `settings` may mount after
 * this plugin. The inject callback deliberately returns nothing — a plain
 * object throws "Invalid effect" and would take the whole plugin down.
 *
 * @param ctx - host plugin context.
 */
export function registerSettings(ctx: DshContext) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['settings'], (scope: DshScope) => {
    const settings = scope.settings
    if (typeof settings?.configure !== 'function') return
    scope.effect(
      () => settings.configure({ auto: false }, ctx.fiber),
      `${PACKAGE_NAME}: settings presentation`,
    )
  })
}
