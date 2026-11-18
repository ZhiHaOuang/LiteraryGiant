/**
 * The models chart's date axis: which days keep a label, and where each label
 * sits.
 *
 * The chart has one column per day at the panel's fixed width, so a thirty-day
 * window gives a date less room than a seven-day one. The tick nearest today is
 * the anchor: labels step back from it by the smallest number of days whose
 * centres clear the widest label, and the axis is read from the right so a
 * label that would run into the next one is the one left out. Today therefore
 * keeps its date, and no two labels touch. A label at either edge is pulled
 * inside the plot rather than hanging past it, and the newest label is the one
 * that survives an axis too narrow for a second.
 */

/** The clear space between two date labels, in the axis's own pixels. */
export const HOME_CHART_LABEL_GAP = 8
/** The gutter the bars and their labels share (home-models.css). */
export const HOME_CHART_COLUMN_GAP = 2

export interface HomeChartTick {
  /** The column the label names, counted from the start of the window. */
  index: number
  /** The label's left edge, counted from the plot's left edge. */
  left: number
}

/**
 * @param widths - each day's label width, measured in the axis's own face.
 * @param axisWidth - the plot's width, the same width the bars are laid out on.
 * @param gap - the clear space two labels keep between them.
 * @param columnGap - the gutter between two columns.
 * @returns the labels to draw, left to right.
 */
export function homeChartTicks(widths: number[], axisWidth: number, gap = HOME_CHART_LABEL_GAP, columnGap = HOME_CHART_COLUMN_GAP): HomeChartTick[] {
  const count = widths.length
  if (count === 0 || !(axisWidth > 0)) return []
  const column = (axisWidth - columnGap * (count - 1)) / count
  if (!(column > 0)) return []
  let widest = 0
  for (let i = 0; i < count; i += 1) {
    if (widths[i] > widest) widest = widths[i]
  }
  // The label at an edge is pulled inside the plot, which moves it half a
  // label width toward the middle: the step has to leave that much more room,
  // or the last pair collides and the filter below leaves a hole before today.
  const edgeShift = Math.max(0, widest / 2 - column / 2)
  // How many days have to pass between two labels for their words to clear.
  let step = 1
  while (step < count && step * (column + columnGap) < widest + gap + edgeShift) step += 1
  const boxes: HomeChartTick[] = []
  for (let i = count - 1; i >= 0; i -= step) {
    const width = widths[i]
    const centre = i * (column + columnGap) + column / 2
    const left = Math.min(Math.max(centre - width / 2, 0), Math.max(axisWidth - width, 0))
    boxes.unshift({ index: i, left })
  }
  // Clamping an edge label can close a gap the step opened: walk back from
  // today and keep a label only while it clears the one after it.
  const kept: HomeChartTick[] = []
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i]
    const next = kept[0]
    if (next === undefined || box.left + widths[box.index] + gap <= next.left) kept.unshift(box)
  }
  return kept
}
