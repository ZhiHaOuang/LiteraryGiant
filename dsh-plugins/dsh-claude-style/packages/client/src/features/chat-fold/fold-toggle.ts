/**
 * The bookkeeping for fold toggles this feature presses itself.
 *
 * The automatic collapse of a thinking row and the automatic open and close
 * of a process group both dispatch real clicks: HTMLElement.click() takes
 * the same capture path as the reader's own press, so each module's
 * "the reader touched it, he wins" guard cannot tell the two apart. Silencing
 * it would cut the reader's streaming text off mid-word, so it is declared
 * here instead and read by both fold modules and the follow guard.
 */
/** How deep this feature's own fold presses are nested. */
export let chatFoldToggleDepth = 0

/**
 * What a scan read about the rows it is about to press, in its frame's read
 * phase (D40): the press runs in the write phase, where the glide's own reads
 * would force the page's layout under every write made before them.
 */
export interface FoldPressReading {
  /** Whether the reader was at the session's end. */
  atBottom: boolean
  /** The height each body a press may roll stood at, in the page's pixels. */
  heights: ReadonlyMap<Element, number>
}

/** The reading the presses in flight were made with. */
let pressReading: FoldPressReading | null = null

/** Mark one of this feature's own fold toggles, so the reader-intent guards ignore it. */
export function beginChatFoldToggle(reading: FoldPressReading | null = null) {
  chatFoldToggleDepth += 1
  if (reading !== null) pressReading = reading
}

/** One of this feature's own fold toggles is over. */
export function endChatFoldToggle() {
  chatFoldToggleDepth = Math.max(0, chatFoldToggleDepth - 1)
  if (chatFoldToggleDepth === 0) pressReading = null
}

/** Whether one of this feature's own fold toggles is in flight right now. */
export function isChatFoldToggle() {
  return chatFoldToggleDepth > 0
}

/** The reading the press in flight was made with, or null when none was taken. */
export function chatFoldPressReading() {
  return chatFoldToggleDepth > 0 ? pressReading : null
}
