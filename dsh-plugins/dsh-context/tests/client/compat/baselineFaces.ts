import { TestClientCtx } from '../helpers/harness'
import type { ConversationNodeLike, UseChatLike } from '../../../src/client/services'

export function convNodes(): ConversationNodeLike[] {
  return [
    { kind: 'user', seq: 4, content: [{ type: 'text', text: 'window node hello' }] },
    { kind: 'assistant', seq: 5, messageId: 'm-5', blocks: [{ kind: 'text', text: 'window reply' }] },
  ]
}

export function chatSeat(nodes: readonly ConversationNodeLike[] | undefined): UseChatLike {
  return selector => selector({ legacy: { nodes } })
}

function historyEvents(): unknown[] {
  return [
    {
      type: 'user/message',
      seq: 4,
      time: 1,
      data: { content: [{ type: 'text', text: 'history node hello' }] },
    },
    { type: 'text-chunks', seq0: 5, time0: 2, members: [] },
  ]
}

export function baselineCtx(): { ctx: TestClientCtx; calls: { page: unknown[]; image: { sessionId: string; attachment: unknown }[] } } {
  const ctx = new TestClientCtx()
  const calls: { page: unknown[]; image: { sessionId: string; attachment: unknown }[] } = { page: [], image: [] }
  const events = historyEvents()

  const page = (request: unknown): Promise<unknown> => {
    calls.page.push(request)
    return Promise.resolve({ ok: true, value: { records: events.map(event => ({ type: 'event', event })) } })
  }
  ctx.setService('remote', { session: { page } })
  ctx.setService('remote.session', {
    get page() { throw new Error('cannot get property "remote.session" without inject') },
  })

  ctx.setService('uiConversation', {
    imageUrl(sessionId: string, attachment: unknown): Promise<string> {
      calls.image.push({ sessionId, attachment })
      return Promise.resolve('blob:modern-image')
    },
  })
  return { ctx, calls }
}
