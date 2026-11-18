import { requestFrame } from '@dsh-claude-style/engine/frame'
import { motionReduced } from '../../core/prefs'
import { motionMs } from '../../shared/motion'
import type { HostSessionStatsProjection, HostTokenUsageProjection } from '@dsh-claude-style/contracts/services'

/**
 * The session's figures counting to their new readings.
 *
 * The line carries its figures as plain text (inline-stats.ts), so a reading
 * that moves rewrites the same words in place: the values the reader sees travel
 * toward the newest reading rather than landing on it.
 *
 * The motion is a chase: each frame closes a share of the distance still left,
 * sized so a reading that stops moving is reached within the duration token
 * (D9). A reading that changes again on the next frame is simply a new target,
 * and the frame loop keeps its own place — a clock restarted per reading never
 * gets going while the readings pour in, and a fixed end stutters each time the
 * target moves. The figures stop within half a unit of the reading, which is
 * where every formatter on the line rounds to it.
 *
 * A reading that arrives while reduced motion is chosen is written as it is, and
 * so is one whose projection has no figure before it to count from. The frame
 * loop runs on the engine's frame pipeline (D40).
 */

/** The two projections the line reads, and the session's cost, as one reading. */
export interface StatsReading {
  stats: HostSessionStatsProjection | null
  usage: HostTokenUsageProjection | null
  /** Micro units of the chosen currency, or null while no figure is known. */
  cost: number | null
  /** Whether the reader has billing on: off takes the cost segment off the line. */
  billing: boolean
  /**
   * Whether the figure is still being fetched: the segment then stands with a
   * dash in its own width. A route the price table does not carry is not
   * pending — there is nothing to wait for, and the segment goes.
   */
  costPending: boolean
}

/**
 * The numbers each projection carries. A reading that moved in any of them is
 * a new one; what is not a number (`dialog`) is taken from the new reading.
 */
const STAT_FIELDS = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
const USAGE_FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const

/** A frame's own interval when this is the run's first frame, and the longest one counted. */
const NOMINAL_FRAME_MS = 16.7
const MAX_FRAME_MS = 64

/** Whether two readings carry the same numbers. */
function sameReading(before: StatsReading, after: StatsReading) {
  return before.cost === after.cost && before.billing === after.billing && before.costPending === after.costPending
    && sameNumbers(before.stats, after.stats, STAT_FIELDS)
    && sameNumbers(before.usage, after.usage, USAGE_FIELDS)
}

/** Whether two projections carry the same numbers, or are both absent. */
function sameNumbers<Shape extends object>(before: Shape | null, after: Shape | null, fields: readonly string[]) {
  if (before === null || after === null) return before === after
  const from = before as Record<string, unknown>
  const to = after as Record<string, unknown>
  for (let i = 0; i < fields.length; i++) {
    if (from[fields[i]] !== to[fields[i]]) return false
  }
  return true
}

/** One projection's numbers `share` of the way from one reading to the next. */
function mixNumbers<Shape extends object>(before: Shape, after: Shape, fields: readonly string[], share: number) {
  const mixed: Record<string, unknown> = { ...(after as Record<string, unknown>) }
  const from = before as Record<string, unknown>
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const start = from[field]
    const target = mixed[field]
    if (typeof start === 'number' && typeof target === 'number') mixed[field] = start + (target - start) * share
  }
  return mixed as Shape
}

/** The reading the line shows: every number between the one before and the new one. */
function mixReading(before: StatsReading, after: StatsReading, share: number): StatsReading {
  return {
    stats: before.stats === null || after.stats === null ? after.stats : mixNumbers(before.stats, after.stats, STAT_FIELDS, share),
    usage: before.usage === null || after.usage === null ? after.usage : mixNumbers(before.usage, after.usage, USAGE_FIELDS, share),
    cost: before.cost === null || after.cost === null ? after.cost : before.cost + (after.cost - before.cost) * share,
    billing: after.billing,
    costPending: after.costPending,
  }
}

/** Whether a reading has numbers on both sides to count between. */
function countable(reading: StatsReading) {
  return reading.stats !== null && reading.usage !== null
}

/** Whether the figures are close enough to the reading that every formatter rounds to it. */
function withinHalfUnit(reading: StatsReading, goal: StatsReading) {
  const costClose = reading.cost === null || goal.cost === null
    ? reading.cost === goal.cost
    : Math.abs(goal.cost - reading.cost) < 0.5
  return costClose && withinHalfOf(reading.stats, goal.stats, STAT_FIELDS) && withinHalfOf(reading.usage, goal.usage, USAGE_FIELDS)
}

/** Whether every number of one projection is within half a unit of the goal's. */
function withinHalfOf<Shape extends object>(reading: Shape | null, goal: Shape | null, fields: readonly string[]) {
  if (reading === null || goal === null) return reading === goal
  const from = reading as Record<string, unknown>
  const to = goal as Record<string, unknown>
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const value = from[field]
    const target = to[field]
    if (typeof value === 'number' && typeof target === 'number' && Math.abs(target - value) >= 0.5) return false
  }
  return true
}

/** A copy of a reading, so the host's projection objects can never move under the count. */
function takeReading(stats: HostSessionStatsProjection | null, usage: HostTokenUsageProjection | null, cost: number | null, billing: boolean, costPending: boolean): StatsReading {
  return {
    stats: stats === null ? null : { ...stats },
    usage: usage === null ? null : { ...usage },
    cost,
    billing,
    costPending,
  }
}

/**
 * The count.
 *
 * @param write - takes the reading the line should show, once per frame while
 *   the figures move, and once more when they arrive.
 * @returns { to, current, goal, reset, stop }.
 */
export function createStatsCount(write: (reading: StatsReading) => void) {
  // A reading that stops moving is within half a unit of its target after about
  // three time constants; the token's stretch is that distance.
  const timeConstant = motionMs('--dsh-claude-duration-count') / 3
  /** The reading the line shows right now. */
  let displayed: StatsReading = { stats: null, usage: null, cost: null, billing: false, costPending: false }
  /** The reading the count is heading for, or null before the first one. */
  let goal: StatsReading | null = null
  /** The last frame this loop ran, and the canceller of the one in flight. */
  let lastAt = 0
  let cancel: (() => void) | null = null

  const frame = {
    write(now: number) {
      const running = goal
      if (running === null) {
        cancel = null
        return
      }
      const elapsed = lastAt === 0 ? NOMINAL_FRAME_MS : Math.min(MAX_FRAME_MS, Math.max(1, now - lastAt))
      lastAt = now
      displayed = mixReading(displayed, running, 1 - Math.exp(-elapsed / timeConstant))
      const arrived = withinHalfUnit(displayed, running)
      if (arrived) displayed = running
      write(displayed)
      if (arrived) {
        cancel = null
        return
      }
      cancel = requestFrame(frame)
    },
  }

  /** Stop the frame in flight; the figures stay where they are. */
  function stop() {
    if (cancel !== null) cancel()
    cancel = null
    lastAt = 0
  }

  /**
   * Take a reading: the figures count to it, or it is written as it is when
   * there is nothing to count from or the reader asked for reduced motion.
   *
   * @returns whether the numbers moved, so a caller knows to measure again.
   */
  function to(reading: StatsReading) {
    if (goal !== null && sameReading(goal, reading)) return false
    goal = takeReading(reading.stats, reading.usage, reading.cost, reading.billing, reading.costPending)
    if (motionReduced() || !countable(displayed) || !countable(goal)) {
      stop()
      displayed = goal
      write(displayed)
      return true
    }
    // The loop already on its way simply takes the new destination; one that is
    // not running starts from where the figures stand.
    if (cancel === null) {
      lastAt = 0
      cancel = requestFrame(frame)
    }
    return true
  }

  return {
    to,
    /** The reading the line is showing part way through a count. */
    current() {
      return displayed
    },
    /** The reading the count is heading for, or null before the first one. */
    goal() {
      return goal
    },
    /** Forget the reading: the next one is written as it comes (the line left the page). */
    reset() {
      stop()
      goal = null
      displayed = { stats: null, usage: null, cost: null, billing: false, costPending: false }
    },
    stop,
  }
}
