import { SODIUM_ON, SODIUM_UNDECIDED } from '../../constants'
import { prefsFromForm, readPrefs, savePrefs, subscribePrefs } from '../../core/prefs'
import { subscribeMutations } from '@dsh-claude-style/engine/bus'
import type { HostContext } from '@dsh-claude-style/engine/host'
import { createSodiumEngine } from './sodium-engine'

/**
 * The sodium rewrite (D78): the host's and the plugins' costly style rules,
 * rewritten in place to read attributes this skin keeps, while the reader has
 * the switch on.
 *
 * The feature is installed whatever the switch says, because the switch starts
 * undecided: while it is, every look at the page is a probe, and the first one
 * that finds a listed rule turns the switch on for the reader. From the first
 * time the reader flips it, the switch holds a decided value the probe leaves
 * alone. `<head>` is watched for the sheets coming and going: a plugin module
 * that loads late injects its sheet after this install, and a sheet injected
 * again is a new object carrying none of the rewrite.
 */
export function install(ctx: HostContext) {
  const engine = createSodiumEngine(ctx)
  let disposed = false
  /** A probe's write is on its way: the next look waits for the form to answer. */
  let probing = false

  function probe() {
    if (probing || !prefsFromForm() || readPrefs().sodium !== SODIUM_UNDECIDED) return
    probing = true
    engine.survey().then((count) => {
      if (disposed || count === 0 || readPrefs().sodium !== SODIUM_UNDECIDED) return null
      return savePrefs({ sodium: SODIUM_ON })
    }).finally(() => { probing = false })
  }

  function follow() {
    if (readPrefs().sodium === SODIUM_ON) engine.start()
    else engine.stop()
    probe()
  }

  const stopPrefs = subscribePrefs(follow)
  const stopHead = subscribeMutations(document.head, { childList: true, subtree: true }, () => {
    engine.refresh()
    probe()
  })
  follow()

  return () => {
    disposed = true
    stopPrefs()
    stopHead()
    engine.stop()
  }
}
