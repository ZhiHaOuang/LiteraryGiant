import { CHAT_FOLD_ATTR } from '../../constants'
import { isChatFoldBusy } from './fold-glide-parts'
import { installChatFoldGlide } from './fold-glide'
import { createMessageFold } from './message-fold'
import { createProcessFold } from './process-fold'
import { createProcessSummary } from './process-summary'
import { createReasoningFold } from './reasoning-fold'
import { createReasoningStream } from './reasoning-stream'
import type { HostContext } from '@dsh-claude-style/engine/host'
import type { FeatureHandle } from '@dsh-claude-style/engine/scheduler'
import type { FeatureUi } from '../../core/feature'
import type manifest from './chat-fold.manifest'

/** What the follow reads off the folding (ui.chatFold): whether a door is rolling. */
export interface ChatFoldHandle extends FeatureHandle {
  isBusy(): boolean
}

/**
 * The chat area's folding, ported from dsh-chat-ux: a thinking row stays open
 * while the model reasons and folds back once it stops (reasoning-fold.ts), a
 * process group opens while its section runs and folds back when it ends
 * (process-fold.ts), a message the reader sent is clamped under a cap while the
 * skin's own toggle under it hands the whole message back (message-fold.ts), a
 * reader's own press on a row rolls the body down or up instead of snapping it
 * (fold-glide.ts), a process group's header counts what the group holds
 * (process-summary.ts), and a running reasoning plays back inside a window that
 * steps up as it streams (reasoning-stream.ts). All of them ride the one
 * preference: it means "the skin may fold the chat area", so off leaves the
 * automatic folding, the door, the header's words, the reasoning's window and
 * the reader's own folded messages to the host.
 *
 * The door takes over the reader's clicks on a folding row, a takeover of the
 * host's interface like any other (D72): the entry installs this only while
 * the preference is on and dsh-chat-ux is off the page (the manifest), and
 * this teardown leaves the clicks alone again. The follow guard asks whether
 * a door is rolling through `ui.chatFold`, which exists only while installed.
 */
export function install(ctx: HostContext, ui: FeatureUi<typeof manifest>) {
  document.body.setAttribute(CHAT_FOLD_ATTR, '')
  const stream = createReasoningStream()
  const stopReasoning = createReasoningFold(rows => {
    for (const row of rows) stream.queueRow(row)
  })
  const stopProcess = createProcessFold()
  const summary = createProcessSummary()
  const messageFold = createMessageFold(() => ui.schedule?.())
  const stopGlide = installChatFoldGlide()
  ui.chatFold = {
    isBusy: isChatFoldBusy,
    measure: () => messageFold.measure(),
    sync: () => messageFold.sync(),
    onCopyChange: () => {
      summary.rewrite()
      stream.sync()
      messageFold.onCopyChange()
    },
    // A resize can change the text's line height (the content font delta), which
    // the window's own height is measured from, and it re-wraps a message's words.
    reposition: () => {
      stream.sync()
      messageFold.reposition()
    },
  }
  return () => {
    delete ui.chatFold
    stream.stop()
    stopReasoning()
    stopProcess()
    summary.stop()
    messageFold.stop()
    stopGlide()
    document.body.removeAttribute(CHAT_FOLD_ATTR)
  }
}
