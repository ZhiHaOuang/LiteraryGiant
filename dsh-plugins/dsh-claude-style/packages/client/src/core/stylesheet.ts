import { UNTAGGED_SHEET_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { mountStylesheet as mountSheet, parkForeignSheets as parkSheets } from '@dsh-claude-style/engine/stylesheet'
import { STYLESHEET } from 'virtual:dsh-claude-style/generated'
import { FOREIGN_SHEET_TAG, PACKAGE_NAME, STYLE_ID, STYLE_PLUGIN_CSS } from '../constants'

/**
 * This package's sheets, named for the engine that mounts them (D9, D73): the
 * mechanism lives in packages/engine/src/stylesheet.ts, and the ids, the plugin
 * name and the built sheet are this package's own.
 */

/**
 * Park a sibling's untagged stylesheet so no package's bookkeeping can take it.
 *
 * Two moments call this, because a sweep never waits for the skin: the module
 * scope of packages/client/src/entry.ts, the only code of ours that runs before
 * the sweep of our own materialization, and the head watch, which sees a sheet
 * arriving after it.
 */
export function parkForeignSheets() {
  parkSheets(UNTAGGED_SHEET_SELECTOR, STYLE_ID, FOREIGN_SHEET_TAG)
}

/**
 * Mount one of the skin's stylesheets, once per generation: the theme's own by
 * default, or the surface sheets under their own id (D74).
 *
 * @param id - the `<style>` element's id.
 * @param text - the sheet.
 * @param pluginCss - the sheet's key in the client module system's bookkeeping.
 * @returns this generation's stop function.
 */
export function mountStylesheet(id = STYLE_ID, text = STYLESHEET, pluginCss = STYLE_PLUGIN_CSS) {
  return mountSheet({ id, text, packageName: PACKAGE_NAME, pluginCss })
}
