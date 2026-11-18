# StackedBars: actual Agent usage

Bencho Stacked bars (MIT, copyright 2026 Lorenzo Cabra); source comments retained.
`StackedBars.tsx` renders complete, server-aggregated time buckets. Every bucket
has Input above and Output below one fine baseline. The sides retain independent
scales. Column width is capped at the supplied 21-bars/300px demo's 148/21 px;
radius stays 2.5px, segment air 2px. Available width determines bucket capacity.
The server selects readable minute/hour/day intervals without sampling requests.

`AgentTimelines.jsx` lays out five simultaneous groups: Summarizer (the four-role
sum, not a fifth Agent) occupies half the width; Lead, Analysis, Planning and
Writing divide the other half. Below 560px the summary spans the card and roles
wrap into two columns. Each group has the same range, with no bottom date axis;
hover shows the exact interval. Small plots merge whole adjacent server buckets
without losing totals or unknown composition. The summary determines fetch
capacity; child plots do not issue competing requests. Tooltips may extend past
a small group but remain inside the chart container.

The six Agent presets are Today, rolling 24 hours, rolling 7/14/30 days and All.
They independently control the Agent card, preserving the selected book.
The Agent dropdown filters KPIs and composition below; all five charts remain
visible for comparison. Last 7 Days remains fixed at seven days. No Classic/demo toggle
remains. The supplied original demo is retained as unreferenced source only.

`overview({period,buckets,path})` adds `monitoring.timeline` to the existing
lg-agent-teams response; older date-only callers are unchanged. Aggregation
includes all selected requests, not the capped 300-row details array. Known
provider totals, unknown composition, missing usage and cache semantics remain
unchanged. The client never substitutes sampled records or fabricated values.
The supplied Bencho Colour palette is used for composition; gray still marks
Unrecorded. Totals and summary percentages use the same selected scope.

## Theme mapping

| Bencho variable | LG mapping |
| --- | --- |
| `--fill-on` | `--dsw-alias-label-primary` |
| `--fill-slab` | `--dsw-alias-bg-layer-1` |
| `--pane-edge` | `--dsw-alias-border-l2` |
| `--font-ui` | `--ds-font-family`, then system font |
| `--c` | segment-local reference to `--stb-c1`…`--stb-c4` |
| `--i` | element-local animation index |
| `--stb-r`, `--stb-rr` | component-local geometry derived from column width |

No global Bencho tokens are created. There are no `-rgb` tokens in this source.
CSS is imported as text and inserted by the component, matching the DSH plugin
build; every chart selector is scoped under `.lgd-stacked-bars`.

## Build and verification

From `dsh-plugins`, with the project's Node version:

```sh
npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
node scripts/build.mjs lg-dashboard
```

`--legacy-peer-deps` avoids the existing Cordis 4.1 / workspace-path 4.0 peer
conflict, and keeps React provided by the DSH host. Framer Motion is pinned to
14.12.0; no existing dependency version changes.

The desktop regression `tests/stacked-bars-desktop.mjs` requires
`LG_PLAYWRIGHT_MODULE`, `LG_APP_EXECUTABLE`, `LG_DASHBOARD_TEST_ROOT` and optionally
`LG_PREVIEW_DIR`. Use an isolated root with a `.dashboard-test-profile` marker,
`home` and `userData` directories and the normal test plugins installed.
The desktop regression checks all six presets, complete totals, slim columns,
responsive group layout and bucket count, baseline direction, role totals,
bounded hover details, selection, keyboard and reduced motion.
`tests/time-stacks.test.mjs` and lg-agent-teams `tests/usage-timeline.test.mjs`
cover aggregation, bounds, books/archives, missing fields and >300 requests.

Last 7 Days uses its unchanged data/height calculation with CSS staggered growth
and a Framer Motion ring/tooltip. `tests/usage-motion-desktop.mjs` mounts the
actual component with synthetic render-only data. It additionally needs
`LG_REACT_MODULE_DIR` and `LG_REACT_DOM_MODULE_DIR`; only the host icon is stubbed.
It verifies values, colors, unknown costs, live updates, narrow size and reduced
motion without writing to a ledger.

The transparent companions frame measures only visible bubbles. One shared
spring height follows the taller visible bubble; after both exit it returns to
zero reserved bubble height. The 650–1400ms rest leaves room for collapse before
the next round. Original speech/exit animations and author-provided lines remain.


2026-11-12: all four statistics modes now share the animated time-bucket renderer
and an Agent-share donut. Tokens alone has paired Input/Output. Context displays
estimated context categories; Requests shows completed/failed/running counts;
Duration shows recorded request phases and unsegmented time, excluding tools.
The single header period control drives Agent exact-time ranges and Context/API
daily ranges. The obsolete date-input strip is removed; Refresh lives in the
Writing folder card. Last 7 Days and Activity still use all-date source days.
All includes known Context history beyond one year. Context/API cannot resolve
partial days from existing daily summaries; the header tooltip documents this.
