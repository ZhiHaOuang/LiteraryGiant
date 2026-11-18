/**
 * The tokens one tool call adds to the written-back figure.
 *
 * The host settles a step's usage with the call's arguments in it, and those
 * arguments are off the page; a step that only calls a tool streams no text at
 * all, so its written-back figure would stand still until the settlement. One
 * count per call row is the moment it can move.
 *
 * A single count cannot price both a `read` and a `write`: the settled output of
 * a step that was nothing but one call varies by the tool several times over, so
 * a mean over that set overprices the common call and underprices the rare one.
 * Each tool's own median is the price its rows carry, read off local session
 * logs as the settled `assistant/message` usage of steps that carried that tool;
 * `Bash`, `Edit`, `Read` and `Write` are the Claude Code route's names, whose
 * calls cost several times the same tool of the host's own, and a tool the table
 * does not name costs the median over every call, so a tool the host adds later
 * is priced rather than free.
 */
const CALL_TOKENS: ReadonlyMap<string, number> = new Map([
  ['Bash', 370],
  ['Edit', 460],
  ['Read', 125],
  ['Write', 1200],
  ['bash', 105],
  ['bsk_inspect', 60],
  ['bsk_interact', 75],
  ['bsk_page', 75],
  ['desktop_eval', 240],
  ['edit', 325],
  ['glob', 55],
  ['grep', 75],
  ['job_output', 70],
  ['ops_bash', 125],
  ['ops_edit_file', 390],
  ['ops_glob', 60],
  ['ops_grep', 115],
  ['ops_read_files', 90],
  ['ops_stat', 45],
  ['ops_write_file', 495],
  ['present', 105],
  ['pwsh', 135],
  ['powershell', 135],
  ['read', 85],
  ['read_image', 55],
  ['run_code', 190],
  ['send_message', 1500],
  ['todo_write', 230],
  ['web_fetch', 55],
  ['write', 605],
])

/** What a call of a tool the table does not name costs: the median over every call. */
const UNKNOWN_CALL_TOKENS = 120

/**
 * The tokens one call row of `tool` adds.
 *
 * @param tool - the tool the row names, or null while the page has not named it.
 */
export function callTokens(tool: string | null) {
  if (tool === null) return UNKNOWN_CALL_TOKENS
  return CALL_TOKENS.get(tool) ?? UNKNOWN_CALL_TOKENS
}
