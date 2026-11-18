/**
 * prices.mjs — the price snapshot the package ships
 *
 * The document is produced by `scripts/fetch-prices.mjs` (run by
 * `.github/workflows/data.yml`) from the official pricing page, committed to
 * `packages/host/data/`, and copied beside the bundle. It is what the host half
 * serves when the repository cannot be reached, so a machine that never gets
 * there still prices its sessions. The build runs the host half's own parser over
 * it, so a snapshot the runtime would refuse cannot ship.
 */
import { loadModule } from './shared/ts-module.mjs'

/** The snapshot's file name under packages/host/data/, and beside the bundle in lib/. */
export const PRICES_FILE = 'prices.json'

/**
 * Check one snapshot with the parser the host half loads it with.
 *
 * @param doc - the parsed JSON.
 * @param file - the path it was read from, for the refusal.
 * @returns how many models the document prices.
 */
export function validatePrices(doc, file) {
  const { parsePriceDocument } = loadModule('packages/host/src/prices-document.ts')
  const parsed = parsePriceDocument(doc)
  if (parsed === null) throw new Error(`build: ${file} is not a price snapshot this build understands`)
  // The line is judged against these two models; a snapshot that lost one of
  // them would leave the sessions on it unpriced while the build stayed green.
  for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
    if (parsed.models[id] === undefined) throw new Error(`build: ${file} prices no "${id}"`)
  }
  return Object.keys(parsed.models).length
}
