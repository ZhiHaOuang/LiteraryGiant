import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'
import type { SliceRow } from './sliceList'

const RING_LABEL: Partial<Record<string, string>> = {
  toolCalls: 'tokens.toolCalls',
  answers: 'stats.answers',
  thinking: 'tokens.thinking',
}

const RING_TIP: Partial<Record<string, string>> = {
  toolCalls: 'tokens.toolCallsTip',
  answers: 'tokens.answersTip',
}

export function tokenRowsOf(kit: ViewKit, parts: readonly PartsPart[], total: number): SliceRow[] {
  const { t, fmt, fmtShare, catLabel } = kit
  return parts.map((p) => {
    const labelKey = RING_LABEL[p.key]
    const tipKey = RING_TIP[p.key]
    return {
      key: p.key,
      color: p.color,
      label: labelKey !== undefined ? t(labelKey) : catLabel(p.key),
      pct: fmtShare(p.value, total),
      count: '≈' + fmt(p.value),
      ...(tipKey !== undefined ? { tip: t(tipKey) } : {}),
    }
  })
}
