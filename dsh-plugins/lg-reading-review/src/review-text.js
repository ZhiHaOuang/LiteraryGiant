export const defaultType = { font: 'serif', size: 18, line: 1.9, gap: 0.75 }

export function paragraphs(text, notes) {
  const spans = notes.filter(note => note.end > note.start && text.slice(note.start, note.end) === note.quote)
    .sort((a,b) => a.start - b.start || a.end - b.end)
  const anchored = new Set()
  let next = 0, active = []
  const rows = []
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const from = match.index, to = from + match[0].length
    active = active.filter(note => note.end > from)
    while (next < spans.length && spans[next].start < to) active.push(spans[next++])
    const cuts = new Set([from, to])
    for (const note of active) {
      cuts.add(Math.max(from, note.start))
      cuts.add(Math.min(to, note.end))
    }
    const points = [...cuts].filter(n => n >= from && n <= to).sort((a,b) => a-b)
    const pieces = points.slice(1).map((end, i) => {
      const start = points[i]
      const ids = active.filter(note => note.start <= start && note.end >= end).map(note => note.id)
      const anchors = ids.filter(id => !anchored.has(id))
      for (const id of anchors) anchored.add(id)
      return {start, text:text.slice(start,end), ids, anchors}
    })
    rows.push({ start: from, pieces })
  }
  // A selection can consist entirely of the break between two paragraphs.
  if (!rows.length && spans.length) rows.push({start:0,pieces:[]})
  let rowIndex = 0
  for (const note of spans) {
    if (anchored.has(note.id)) continue
    while (rowIndex + 1 < rows.length && rows[rowIndex + 1].start <= note.start) rowIndex++
    const row = rows[rowIndex], marker = {start:note.start,text:'',ids:[note.id],anchors:[note.id]}
    if (note.start < row.start) row.pieces.unshift(marker)
    else row.pieces.push(marker)
  }
  return rows
}

export function selectedPassage(root, source) {
  const selection = root?.ownerDocument.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  function position(node, offset) {
    const element = node.nodeType === 1 ? node : node.parentElement
    const paragraph = element?.closest('[data-text-start]')
    if (!paragraph || !root.contains(paragraph)) return null
    const prefix = root.ownerDocument.createRange()
    prefix.selectNodeContents(paragraph)
    prefix.setEnd(node, offset)
    return Number(paragraph.dataset.textStart) + prefix.toString().length
  }
  const start = position(range.startContainer, range.startOffset)
  const end = position(range.endContainer, range.endOffset)
  if (start == null || end == null || end <= start) return null
  return { start, end, quote: source.slice(start,end) }
}

export function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
export function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Storage may be disabled. */ }
}
