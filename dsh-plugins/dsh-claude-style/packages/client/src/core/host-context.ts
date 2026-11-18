import type { HostContext } from '@dsh-claude-style/engine/host'
import { resetIdentity } from '../shared/identity'

/**
 * Host context reference for services that read host state outside apply(ctx)'s call stack.
 */
export let hostCtx: HostContext | null = null

export function setHostContext(ctx: HostContext | null) {
  hostCtx = ctx
  resetIdentity()
}
