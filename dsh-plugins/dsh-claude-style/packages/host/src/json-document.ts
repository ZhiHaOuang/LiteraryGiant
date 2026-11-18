/**
 * The reading two document validators share: what a JSON value is once it has
 * been parsed, asked the same way in both places.
 *
 * The peak rate catalog and the price snapshot are different documents with the
 * same job — a third party's or a build step's JSON that must be held to a shape
 * before anything judges by it — so both checks start from the same question.
 */

/** One object's members, or null when the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
