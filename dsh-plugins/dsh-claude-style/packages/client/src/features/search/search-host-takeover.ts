import { requestFrame } from '@dsh-claude-style/engine/frame'
import { SIDEBAR_SEARCH_SLOT_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { cacheFirstMatch } from '@dsh-claude-style/engine/host'
import type { HostContext } from '@dsh-claude-style/engine/host'

/**
 * The host's own sidebar search, taken over: the host's search shortcut
 * (Ctrl+K) and its rail button end in its own sidebar search taking focus;
 * search.css keeps that control out of sight, and the palette opens in its
 * place. The takeover follows whatever button React mounts this time, and
 * folds the host's search back through its own clear button, which exists
 * once the expanded state has rendered — a frame or two after the first
 * focus.
 */
export function createHostSearchTakeover(options: {
  ctx: HostContext
  /** Open the palette. */
  open(): void
  /** Whether the palette takes input right now. */
  isOpen(): boolean
  /** Focus the palette's field, when it stands open. */
  focusField(): void
  /** Whether the feature's teardown has run. */
  isDisposed(): boolean
}) {
  /** The host's own sidebar search, which the palette stands in for. */
  const HOST_SEARCH = SIDEBAR_SEARCH_SLOT_SELECTOR
  /**
   * The host's own search button, and the listener on it: the `icon` style
   * leaves that button where the host draws it and opens the palette from its
   * click, so the listener follows the element React mounts this time. Kept
   * while it stays the first match (D40): the pass reads it every frame.
   */
  let hostButton: HTMLElement | null = null
  const hostSearchButton = cacheFirstMatch<HTMLElement>(`${HOST_SEARCH} button`)

  /**
   * The host's own search button, whose click opens the palette in the `icon`
   * style: the listener follows the element React mounts this time, because a
   * re-render can replace it.
   */
  function syncHostButton() {
    const found = hostSearchButton()
    if (found === hostButton) return
    if (hostButton !== null) hostButton.removeEventListener('click', onHostSearchClick)
    hostButton = found
    if (hostButton !== null) hostButton.addEventListener('click', onHostSearchClick)
  }

  /**
   * The host's own click, taken over: the palette opens in its place. The
   * press never reaches the host's own handler, so its search input never
   * expands and the header keeps its actions.
   */
  function onHostSearchClick(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    options.open()
  }

  function onFocusIn(target: HTMLElement) {
    if (target.tagName !== 'INPUT' || target.closest(HOST_SEARCH) === null) return
    target.blur()
    if (options.isOpen()) options.focusField()
    else options.open()
    foldHostSearch(3)
  }

  function foldHostSearch(tries: number) {
    requestFrame({
      write() {
        if (options.isDisposed()) return
        const clear = document.querySelector<HTMLElement>(`${HOST_SEARCH} [data-dsh-claude-part~="clear-button"]`)
        if (clear !== null) {
          clear.click()
          return
        }
        if (tries > 1) foldHostSearch(tries - 1)
      },
    })
  }

  return {
    /** Follow the host's search button as React re-mounts it. */
    sync: syncHostButton,
    onFocusIn,
    /** Take the listener off the host's button. */
    detach() {
      if (hostButton !== null) {
        hostButton.removeEventListener('click', onHostSearchClick)
        hostButton = null
      }
    },
  }
}
