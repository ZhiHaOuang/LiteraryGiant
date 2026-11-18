/**
 * The multiplier a model's streaming estimate is written at.
 *
 * The text prices and the per-tool call prices were fitted to one provider's
 * tokenizer, and another route prices the same text differently. A session's own
 * settled steps are the measure of that difference: each settlement compares the
 * tokens the figure had added for the step with the tokens the host settled for
 * it, and the ratios that model's recent steps show put the multiplier between
 * `SCALE_MIN` and `SCALE_MAX`.
 *
 * The median of the recent ratios is what the multiplier follows: a step that
 * wrote a large file settles far under the figure while the steps around it do
 * not, and a mean would follow those few steps instead of the usual one. A
 * settlement under `RATIO_FLOOR` tokens is no sample — a few tokens either way
 * says nothing about the price.
 */

/** How far the multiplier may move from the fitted estimate. */
export const SCALE_MIN = 0.9
export const SCALE_MAX = 1.1

/** The settlements a model's multiplier reads, newest last. */
const SAMPLE_COUNT = 20
/** The fewest settled tokens a settlement needs to be a sample. */
const RATIO_FLOOR = 40

/** The median of `samples`. */
function median(samples: readonly number[]) {
  const ordered = [...samples].sort((left, right) => left - right)
  const middle = ordered.length >> 1
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

/**
 * The multiplier `samples` are written at: the inverse of their median ratio,
 * held inside the band. With no sample yet the fitted estimate stands.
 */
export function estimateScale(samples: readonly number[]) {
  if (samples.length === 0) return 1
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, 1 / median(samples)))
}

/**
 * The samples after one settlement.
 *
 * @param samples - the model's ratios so far, newest last.
 * @param estimated - the tokens the figure had added for the step.
 * @param settled - the tokens the host settled for it.
 */
export function recordSettlement(samples: readonly number[], estimated: number, settled: number) {
  if (estimated <= 0 || settled < RATIO_FLOOR) return samples
  const next = [...samples, estimated / settled]
  return next.length <= SAMPLE_COUNT ? next : next.slice(next.length - SAMPLE_COUNT)
}
