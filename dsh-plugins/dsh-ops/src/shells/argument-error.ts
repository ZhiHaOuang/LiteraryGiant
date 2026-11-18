/**
 * The refusal one bad `ops_bash` argument deserves, as a distinguishable type.
 *
 * The tool body validates its own arguments because this plugin registers a
 * plain definition through `ctx.tools.register` — the path that avoids an
 * `@deepseek-ai/*` value import — and that path validates only `output.schema`;
 * the model's arguments reach `execute` verbatim. The refusals used to be plain
 * `Error`s, and the session layer, whose contract is that a *runtime* failure
 * comes back as a value rather than a thrown error (#168), folded them into
 * `{ error }` too. That folded value then failed the registered
 * `BASH_OUTPUT_SCHEMA` — it carries no `timedOut`/`timeoutMs`/`stdout`/`stderr` —
 * and the host reported "returned invalid output": the argument that was
 * actually wrong never reached the caller (#204 P1, #235).
 *
 * A distinct type is what lets the session layer keep the two apart: the
 * internal validator throws a refusal naming the field; the public host adapter
 * converts it to a failed foreground value with no effects and input-change guidance.
 *
 * @module dsh-ops/shells/argument-error
 */

/** The `code` {@link BashArgumentError} carries, for refusals that lost their type. */
export const BASH_ARGUMENT_ERROR_CODE = 'INVALID_BASH_ARGUMENT'

/**
 * One `ops_bash` argument this tool cannot run with.
 *
 * It is thrown before anything is spawned, so a caller that sees it knows no
 * command ran and which field to fix.
 */
export class BashArgumentError extends Error {
  declare readonly code: string
  declare readonly argument?: string
  /**
   * @param {string} message - the refusal, naming the argument and what was expected.
   * @param {string} [argument] - the declared argument to fix, when the refusal is one field.
   */
  constructor(message: string, argument?: string) {
    super(message)
    this.name = 'BashArgumentError'
    this.code = BASH_ARGUMENT_ERROR_CODE
    if (argument !== undefined) this.argument = argument
  }
}

/**
 * Whether one thrown value is this layer's argument refusal.
 *
 * The `code` is checked as well as the type so a refusal that lost its
 * prototype — a second copy of the class, a serialized error — is still reported
 * as a caller mistake instead of being folded back into a runtime value, which
 * is the bug (#235) this type exists to prevent.
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether it is an argument refusal.
 */
export function isBashArgumentError(error: unknown) {
  return error instanceof BashArgumentError || ((typeof error === 'object' && error !== null || typeof error === 'function') && 'code' in error && error.code === BASH_ARGUMENT_ERROR_CODE)
}
