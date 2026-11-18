/**
 * motion-tokens.mjs — the motion tokens as the browser half reads them (D9),
 * in one place beside the token document they come from: the build generates the
 * module the page imports from these values, and the unit tests' config serves
 * the same ones. Deliberately free of the build's own dependencies, so a config
 * file can read it.
 */

/**
 * @param doc - packages/client/src/theme/tokens.json (its `motion` group).
 * @returns token → value, for the generated module's MOTION.
 */
export function motionValues(doc) {
  return Object.fromEntries(doc.motion.map((item) => [item.token, item.value]))
}
