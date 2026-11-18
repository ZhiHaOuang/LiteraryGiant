/** Each retained page binds its own Session; the default seat still inherits the main view. */
import { useEffect, useState } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

export interface ConversationPanelInjected {
  retainSession: (id: SessionId) => SessionReference
}
type Props = PropsRuntime<'main'> & PropsRenderSlots<'main.conversation'> & ConversationPanelInjected

export function ConversationPanel({ page, retainSession, SessionProvider, renderSlot }: Props) {
  const id = page?.target.sessionId
  const sessionId = typeof id === 'string' ? id as SessionId : undefined
  const [reference, setReference] = useState<SessionReference>()
  useEffect(() => {
    if (sessionId === undefined) return
    const next = retainSession(sessionId)
    setReference(next)
    // ChatView owns the Session open-error display and retry action.
    void next.ready.catch((_error: unknown) => {})
    return () => { next.release() }
  }, [sessionId, retainSession])
  if (sessionId === undefined) {
    const content = renderSlot('main.conversation', {})
    return page === undefined ? content : <SessionProvider session={undefined}>{content}</SessionProvider>
  }
  if (reference?.sessionId !== sessionId) return null
  return <SessionProvider session={reference}>{renderSlot('main.conversation', {})}</SessionProvider>
}
