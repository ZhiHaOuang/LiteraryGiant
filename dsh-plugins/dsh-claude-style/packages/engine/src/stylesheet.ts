/**
 * Mounting a plugin's own sheets, and keeping a sibling's out of the client
 * module system's bookkeeping (D9).
 *
 * The mechanism knows nothing of the skin it serves: which sheet is mounted
 * under which id, and which tag parks a sibling's, is handed in with each call.
 */

/** The generation whose copy of each sheet is mounted, by the sheet's element id. */
const mountedGenerations = new Map<string, number>()
/** The last generation handed out, across the sheets. */
let lastGeneration = 0

/** One sheet, as the package that owns it mounts it. */
export interface SheetRequest {
  /** The `<style>` element's id. */
  id: string
  /** The sheet's text. */
  text: string
  /** The package's own name, as its bookkeeping spells it. */
  packageName: string
  /** The sheet's key in the client module system's bookkeeping. */
  pluginCss: string
}

/**
 * Park a sibling's untagged stylesheet so no package's bookkeeping can take it.
 *
 * The client module system claims every untagged `<style>` in the document for
 * the package whose factory has just materialized (`claimStyles`, reading
 * `style:not([data-plugin])`), and that package's next reload removes every tag
 * carrying its id (`removeOwnedStyles`). A sibling that mounts its sheet from
 * `apply()` — after its own materialization — leaves it untagged, so the next
 * package to materialize would take it into custody and delete it at that
 * package's next reload, stripping the sibling's rules off a page that keeps
 * running. Every untagged sheet that is not this package's own is therefore
 * parked under a resting tag: the tag carries a slash, can never equal a package
 * name, and matches no removal step, so the sibling keeps its sheet — and its
 * own teardown still removes that sheet by reference when its generation ends.
 *
 * @param untaggedSelector - what an untagged sheet matches.
 * @param styleId - this package's own sheet, which is left alone.
 * @param foreignTag - the resting tag a sibling's sheet is parked under.
 */
export function parkForeignSheets(untaggedSelector: string, styleId: string, foreignTag: string) {
  const untagged = document.querySelectorAll<HTMLStyleElement>(untaggedSelector)
  for (const el of untagged) {
    if (el.id !== styleId) el.dataset.plugin = foreignTag
  }
}

/**
 * Mount one of a package's stylesheets, once per generation (D74).
 *
 * The sheet wears the package's own `data-plugin` and its own `data-plugin-css`
 * from the moment it exists — the claim sweep reads untagged tags alone — so no
 * sibling package's bookkeeping can take it, and it is refreshed in place rather
 * than replaced, so a stale generation's stop can never take a newer
 * generation's sheet away (D9).
 *
 * @param request - the sheet, its element id and the package's own names.
 * @returns this generation's stop function: it unmounts the sheet unless a
 *          newer generation mounted after it.
 */
export function mountStylesheet(request: SheetRequest) {
  const { id, text, packageName, pluginCss } = request
  const generation = ++lastGeneration
  mountedGenerations.set(id, generation)
  let sheet = document.getElementById(id)
  if (sheet === null) {
    sheet = document.createElement('style')
    sheet.id = id
    document.head.appendChild(sheet)
  }
  sheet.dataset.plugin = packageName
  sheet.dataset.pluginCss = pluginCss
  sheet.dataset.skinChrome = id
  if (sheet.textContent !== text) sheet.textContent = text
  return () => {
    if (mountedGenerations.get(id) === generation) sheet.remove()
  }
}
