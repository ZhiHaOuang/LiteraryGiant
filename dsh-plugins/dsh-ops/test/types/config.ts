import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../../src/config.js'
import type { TuiPanels } from '../../src/components/tui/index.js'
import { resolveConfig } from '../../src/config.js'
import { updatedConfig, mountConfigUpdates } from '../../src/config-updates.js'
import { apply as applyTui } from '../../src/components/tui/index.js'
import { apply as applyBackground } from '../../src/components/background/index.js'

declare const raw: unknown, ctx: Context, panels: TuiPanels
const config: ResolvedConfig = resolveConfig(raw)
const required: boolean = config.required
const executable: string | undefined = config.bashPath
const policy: 'advise' | 'deny-host-shell' = config.shellPolicy
const migrated: Record<string, unknown> = updatedConfig(raw)
mountConfigUpdates(ctx, raw)
applyTui(ctx, raw)
applyBackground(ctx, raw)
// @ts-expect-error Validated booleans cannot be confused with string values.
const invalid: string = config.denyCredentialReads
// @ts-expect-error A shell policy must remain one of the validated alternatives.
config.shellPolicy = 'allow'
// @ts-expect-error A raw migration does not validate unknown saved expressions.
const unvalidated: boolean = migrated.allowSystemShellFallback
// @ts-expect-error Evaluated fallback control must be a boolean.
updatedConfig({}, 'false')
// @ts-expect-error Component mounting requires the host context contract.
applyTui({}, raw)
// @ts-expect-error Panel badges cannot carry an undeclared alert level.
panels.badge('overview', { level: 'critical', unread: 1 })
void [required, executable, policy, invalid, unvalidated]
