const VISIBILITY = { checkOpacity: true, checkVisibilityCSS: true }

/** A sibling owns the wording only when it replaces externally hidden host words. */
export function foreignRunningLineOwns(words: HTMLElement, ownLine: HTMLElement | undefined, wordsAttribute: string) {
  const siblings = words.parentElement?.children
  if (siblings === undefined) return false
  const replacement = [...siblings].some(element =>
    element !== words && element !== ownLine && element instanceof HTMLElement &&
    element.getAttribute('aria-hidden') !== 'true' && element.checkVisibility(VISIBILITY) &&
    element.innerText.trim() !== '',
  )
  if (!replacement) return false
  // Our hiding marker is removed only during this synchronous reading, before
  // the browser paints; another plugin's own hiding remains in effect.
  const marked = words.hasAttribute(wordsAttribute)
  if (marked) words.removeAttribute(wordsAttribute)
  try {
    return !words.checkVisibility(VISIBILITY)
  } finally {
    if (marked) words.setAttribute(wordsAttribute, '')
  }
}
