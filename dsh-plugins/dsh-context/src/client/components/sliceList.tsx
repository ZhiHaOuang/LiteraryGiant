import { type ReactElement } from 'react'

export interface SliceRow {
  key: string
  color: string
  label: string
  pct: string
  count: string
  tip?: string
  dim?: boolean
}

export interface SliceListProps {
  rows: SliceRow[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function SliceList(props: SliceListProps): ReactElement {
  return (
    <div className="lc-sl flex-auto @max-[240px]/lc-card:basis-full" onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}>
      {props.rows.map(r => (
        <div
          key={r.key}
          className={'lc-sl-row'
            + (r.dim ? ' lc-sl-row-dim' : '')
            + (props.hoverKey !== undefined && props.hoverKey === r.key ? ' lc-sl-row-on' : '')}
          title={r.tip}
          onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(r.key) }}
        >
          <div className="lc-sl-main">
            <i className="lc-sl-dot" style={{ background: r.color }} />
            <span className="lc-sl-label" title={r.tip ?? r.label}>{r.label}</span>
            <span className="lc-sl-pct">{r.pct}</span>
          </div>
          {r.count !== '' ? <div className="lc-sl-sub" title={r.count}>{r.count}</div> : null}
        </div>
      ))}
    </div>
  )
}
