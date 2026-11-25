import type { Context } from '@deepseek-ai/cordis'
import { MenuRegistry } from '../../ui-context-menu/src/client/registry.ts'
import { createContextMenuBindings } from '../../ui-context-menu/src/client/trigger.ts'

/** Real menu resolution/trigger bindings, without mounting the unrelated overlay. */
export function provideContextMenus(ctx: Context) {
  const registry = new MenuRegistry(() => {})
  ctx.effect(() => () => registry.dispose(), 'test menus')
  ctx.provide('contextMenus', { register: registry.register.bind(registry), resolve: registry.resolve.bind(registry) } as never)
  ctx.get('slots')!.provideRoot({ props: { useContextMenu: () => createContextMenuBindings(() => {}, () => true) } })
}
