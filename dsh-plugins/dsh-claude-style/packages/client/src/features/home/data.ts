/**
 * The usage panel's data: the roll-up store (home-store.ts) and the figures
 * both views derive from it (home-figures.ts), exported under the one face the
 * views and the pure surface read. The store reads the host half's roll-up
 * route and the session list's own projections; the figures carry the range
 * window, the heat grid, the ranked model list and the per-day per-model
 * totals the models chart stacks.
 */
export { createHomeUsage, homeDayKey } from './home-store'
export type { HomeUsageState, ListedModel, ListSummary } from './home-store'
export {
  HOME_BOOKS, HOME_CHART_DAYS, HOME_HEAT_STEPS, HOME_HEAT_WEEKS, HOME_MODEL_ROWS, HOME_RANGES,
  formatHomeCount, formatHomeHour, homeDayTokens, homeHeatGrid, homeModelDays, homeModelList,
  homeModelTokens, homePanelData, homeRangeStart, homeShortDate, homeShortDateFormat,
} from './home-figures'
export type { HeatCell, HomeModel, HomePanel } from './home-figures'
