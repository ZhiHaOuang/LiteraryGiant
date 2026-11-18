/**
 * rule-key.mjs — a style rule as the text the build and the importance walk both key on.
 *
 * One rule's key is its selector with runs of whitespace collapsed, followed by
 * its declarations in source order, each spelled `prop:value` with `!` when it
 * carries `!important`. The build writes it while checking the sheet
 * (scripts/css.mjs) and the importance walk writes it while deciding each
 * declaration (packages/testing/importance-audit.mjs); the two have to spell a
 * rule the same way or the ledger would never match, so the function lives here
 * rather than in the testing lane the build must not read.
 */

/** One rule as text that survives the build: its selector and its declarations. */
function ruleKey(rule) {
  return `${rule.selector.replace(/\s+/g, ' ')}{${rule.nodes.filter((node) => node.type === 'decl').map((node) => `${node.prop}:${node.value}${node.important ? '!' : ''}`).join(';')}}`
}

export { ruleKey }
