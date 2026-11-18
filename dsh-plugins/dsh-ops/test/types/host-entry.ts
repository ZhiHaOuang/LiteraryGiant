import type { Context } from '@deepseek-ai/cordis'
import { apply, applyComponent } from '../../src/index.js'

declare const ctx: Context
declare const raw: unknown
apply(ctx, raw)
applyComponent(ctx, raw, 'shell')
applyComponent(ctx, raw, 'file')
// @ts-expect-error The component entry requires a real host Context.
apply({}, raw)
// @ts-expect-error This entry owns only the shell and Native file components.
applyComponent(ctx, raw, 'ptc')
// @ts-expect-error Component selection must be explicit.
applyComponent(ctx, raw)
