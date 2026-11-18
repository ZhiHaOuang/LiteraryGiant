import type { ReactElement } from 'react'
import { settledVariantOf, type CommsRow } from '../fleetDetail'
import type { ViewKit } from '../viewkit'

export function commsTextOf(row: CommsRow, t: ViewKit['t']): string {
  const settled = row.kind === 'settled' ? settledVariantOf(row.summary ?? row.text) : null
  return settled !== null ? t(`fleet.settled.${settled}`) : row.text
}

export function CommsParties(props: {
  row: CommsRow
  selfId?: string
  labelOf: (id: string) => string
  onPin: (id: string | null) => void
  peerClass: string
}): ReactElement {
  const { row, labelOf } = props
  const from = row.from
  const fromLabel = row.fromName ?? (from !== undefined ? labelOf(from) : undefined)
  const fromIsSelf = from !== undefined && from === props.selfId
  return (
    <>
      {from !== undefined && !fromIsSelf ? (
        <button type="button" className={props.peerClass} onClick={() => { props.onPin(from) }}>
          {fromLabel}
        </button>
      ) : fromLabel !== undefined ? (
        <span className={props.peerClass}>{fromLabel}</span>
      ) : null}
      <span className="lc-comms-arrow">→</span>
      <button type="button" className={props.peerClass} onClick={() => { props.onPin(row.to) }}>
        {labelOf(row.to)}
      </button>
    </>
  )
}
