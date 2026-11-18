import { ContextIcon } from './icon'
import { modalStoreOf, setPendingConsume } from './modalStore'
import type { ClientCtx, InputTriggersFace } from './services'
import type { ViewKit } from './viewkit'

const COMMAND = 'context'
const LINE = '/' + COMMAND

export function registerContextCommand(ctx: ClientCtx, kit: ViewKit): void {
  ctx.inject(['inputTriggers'], (ictx) => {
    const inputTriggers = (ictx as ClientCtx).get('inputTriggers') as InputTriggersFace | undefined
    if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') return
    ictx.effect(() => inputTriggers.registerSource({
      trigger: '/',
      name: COMMAND,
      order: 1,
      candidates: (_session, req) => {
        if (req.position !== 'leading') return Promise.resolve([])
        const query = req.query.trim().toLowerCase()
        if (query !== '' && !COMMAND.startsWith(query)) return Promise.resolve([])
        return Promise.resolve([{
          name: COMMAND,
          label: kit.t('cmd.label'),
          icon: ContextIcon,
          section: kit.t('cmd.section'),
          description: kit.t('cmd.desc'),
        }])
      },
      onPick: (pick) => {
        setPendingConsume(pick.session.sessionId, { kind: 'span', span: pick.span })
        modalStoreOf(pick.session.sessionId).set(true)
        return 'handled'
      },
      matchEnter: (session, line) => {
        if (line !== LINE) return Promise.resolve(undefined)
        setPendingConsume(session.sessionId, { kind: 'bare-token', token: LINE })
        modalStoreOf(session.sessionId).set(true)
        return Promise.resolve<'handled'>('handled')
      },
    }), 'dsh-context: /context command')
  })
}
