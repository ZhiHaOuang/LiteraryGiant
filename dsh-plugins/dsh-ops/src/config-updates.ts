/** Update configuration modification area.
 * Append migrations here; never spread upgrade write-back across components.
 * Markers belong to each owning config row, not a machine-global sentinel.
 * The 0.4 seven-row upgrade is additive bundle composition, not a config rewrite:
 * stable IDs and names preserve saved on/off/config overrides, and the Loader
 * adds discovery from cordis.patch.yml. Never copy the composed tree into a
 * profile or rename dsh-ops/file: name-qualified overrides would be skipped.
 * Explicit legacy panel capture:false is retained; no migration may start capture.
 */
import type { Context } from './adapter/dsh/types.js'
import type {} from './adapter/dsh/types.js'
import { LEGACY_FASTCTX_KEYS } from './config.js'

export const CONFIG_UPDATE_VERSION = 2

/** Apply every pending step in order; each step runs exactly once per row. */
export function updatedConfig(value: unknown = {}, disableEvaluatedFallback = false): Record<string, unknown> {
  // The component validates effective config first; persisted raw rows can still
  // contain loader expressions, so preserve their unknown values until the editor validates.
  const raw = value as Record<string, unknown> | null | undefined
  const marker = raw?.configUpdateVersion
  const version = typeof marker === 'number' && Number.isSafeInteger(marker) ? marker : 0
  if (version >= CONFIG_UPDATE_VERSION) return raw!
  const next = { ...raw }
  // 1 (0.2.5): retire the old implicit system-bash opt-in. Later manual opt-ins are kept.
  if (version < 1 && (raw?.allowSystemShellFallback === true || disableEvaluatedFallback)) next.allowSystemShellFallback = false
  // 2: drop the keys only the removed FastCtx surface read.
  if (version < 2) for (const key of LEGACY_FASTCTX_KEYS) delete next[key]
  next.configUpdateVersion = CONFIG_UPDATE_VERSION
  return next
}

// `dsh-ops/background` is a no-op stub that reads no config, so it needs no migration.
const OWN_NAMES = new Set(['dsh-ops', 'dsh-ops/shell', 'dsh-ops/file'])
const pending = new WeakSet()

// #136's discipline, kept in the middle of #138's persistence: a missing editor and a refused save
// are not faults an operator can act on during boot, and a host that mounts several dsh-ops rows
// would otherwise repeat the same line on every activation of every row. Each is said once per
// logger — in practice once per process — and the migration always stays in effect regardless.
const notedInMemory = new WeakSet()
const warnedSaveFailure = new WeakSet()
/** True only the first time this logger is seen, so a notice is per process, not per row. */
function firstSight(set: WeakSet<object>, logger: unknown): boolean {
  // `WeakSet` keys must be objects; a logger that is missing or not one cannot be tracked, and
  // there is nothing to log to anyway.
  if (!logger || (typeof logger !== 'object' && typeof logger !== 'function')) return false
  if (set.has(logger)) return false
  set.add(logger)
  return true
}
function noteInMemoryOnly(ctx: Context, reason: string): void {
  if (!firstSight(notedInMemory, ctx.logger)) return
  ctx.logger.info?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} applied in memory only (${reason}); the migration is in effect for this activation.`)
}
function warnSaveFailure(ctx: Context, error: unknown): void {
  if (!firstSight(warnedSaveFailure, ctx.logger)) return
  // Anything can be thrown: `error.message` on `undefined`/`null` would raise from inside the very
  // handler that promises to report a failed save, turning it into an unhandled rejection.
  const reason = error instanceof Error ? error.message : String(error)
  ctx.logger.warn?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} could not be saved: ${reason}; the migration stays in effect for this activation only.`)
}

/** Save only this component's raw owning row through the profile config editor.
 *
 * Runtime migration happens synchronously in apply before any executor resolves;
 * this function only records that it ran. The write is submitted through
 * `configEditor.edit()`, which rewrites the **active profile's patch layer** —
 * validating the whole candidate before touching disk, preserving YAML comments
 * and `!!js` expressions outside the replaced value, and serializing with
 * profile changes and HMR.
 *
 * Deliberately **never** `EntryTree.write()` (#91, #108). That API is a
 * whole-composed-tree write-back: it bakes every composed row into the profile
 * root file, which the profile loader documents as an empty entry list that it
 * defensively resets on boot. The stale copy then carries *other* plugins'
 * settings rows — `ui-theme`'s `preference`/`fontSize` above all — so changing
 * the theme or font size echoes the previous value back into the settings scope
 * and the row visibly bounces (dark -> system -> dark). Routing the marker
 * through the patch layer leaves every other row untouched.
 *
 * Errors, and a profile without the editor, degrade to an in-memory migration:
 * the effective config was already derived from `updatedConfig()` in
 * applyComponent, so the runtime stays confined either way and the next
 * activation retries the save. That degradation is #136's behaviour on purpose —
 * it never writes anything, never surfaces an error into the boot path, and never
 * needs an owning row to be correct — while the save itself is #138's channel.
 */
export function mountConfigUpdates(ctx: Context, value: unknown): void {
  // The entry point already validated this effective configuration.
  const raw = value as Record<string, unknown> | null | undefined
  if (((raw?.configUpdateVersion ?? 0) as number) >= CONFIG_UPDATE_VERSION) return
  const entry = ctx.fiber?.entry
  // A row this plugin does not own is none of our business: say nothing (#138's scope guard keeps
  // the no-op `dsh-ops/background` stub out of the save path). A context with no owning row at all
  // still migrates, and says so once instead of warning on every activation (#136).
  if (!entry) { noteInMemoryOnly(ctx, 'this activation has no owning loader row'); return }
  if (!OWN_NAMES.has(entry.options?.name)) return
  if (pending.has(entry)) return
  pending.add(entry)
  let cancelled = false
  const immediate = setImmediate(() => {
    if (cancelled) { pending.delete(entry); return }
    void (async () => {
      try {
        const previous = entry.options.config ?? {}
        if (updatedConfig(previous, raw?.allowSystemShellFallback === true) === previous) return
        // Read the service late: this runs after the current mount tick, so a
        // sibling config-editor row mounted later in the same tree is visible.
        const editor = ctx.get?.('configEditor')
        if (typeof editor?.edit !== 'function') {
          noteInMemoryOnly(ctx, 'the profile config editor is unavailable')
          return
        }
        // Re-check cancellation at the deferred write, not only in the scheduler above (#30). The
        // migration must not land on a row this activation has already torn down.
        if (cancelled) return
        // The candidate must be derived from the value the editor hands the callback, not
        // from one captured at scheduling time: `edit()` re-reads the row under the profile
        // lock and passes *that* authoritative `current`. Returning a scheduled `next`
        // would silently drop any edit that landed in between (#138 review).
        await editor.edit(entry, current => updatedConfig(current ?? {}, raw?.allowSystemShellFallback === true))
        ctx.logger?.info?.(`dsh-ops: config update ${CONFIG_UPDATE_VERSION} saved to the profile patch; legacy system shell fallback disabled (if previously true) and removed FastCtx keys dropped.`)
      } catch (error) {
        // The editor owns the transaction: on failure it restores the patch file and
        // reconciles the previous patches before rethrowing, and it may already have
        // replaced the entry. There is nothing to roll back here — and touching
        // `entry.options.config` could clobber a newer row. The marker simply stays
        // unsaved, so the next activation retries.
        warnSaveFailure(ctx, error)
      } finally { pending.delete(entry) }
    })()
  })
  ctx.effect(() => () => { cancelled = true; clearImmediate(immediate); pending.delete(entry) }, 'dsh-ops: pending config update')
}
