import { PRICE_ROWS_MAX } from '../../constants'
import { billingRowEntry, parseBillingTable, splitBillingRow } from '@dsh-claude-style/contracts/billing-table'
import type { BillingRow } from '@dsh-claude-style/contracts/billing-table'
import { registerPopover, unregisterPopover } from '../../shared/popover'
import { copy } from './copy'

/**
 * The custom price table's editor (the settings page's "编辑" button).
 *
 * A modal card on `<body>` rather than inside the settings dialog: the dialog
 * clips and may transform its own subtree, and a card standing over the window
 * has to be measured against the window. Rows are edited as text and stored as
 * `model|input|cacheRead|output` (contracts/billing-table.ts), which is the
 * shape both halves parse.
 *
 * The rows a reader has not written yet are offered from `unpriced`: the models
 * the price table could not price that the page has seen, so filling the table
 * starts from the names that need it.
 */

/** The models the page could not price, in the order they were first seen. */
const unpriced = new Set<string>()

/** Note one model the price table cannot price. */
export function noteUnpricedModel(modelId: string) {
  const id = modelId.trim()
  if (id !== '') unpriced.add(id)
}

/** The models the price table cannot price, newest last. */
export function unpricedModels(): string[] {
  return [...unpriced]
}

/** The open editor's own node, if any. */
let openCard: HTMLElement | null = null

/** One row being edited: four text fields, the model's and its three rates. */
interface EditRow {
  model: string
  input: string
  cacheRead: string
  output: string
}

/** What the editor hands back on save. */
export type BillingTableWrite = (entries: string[]) => void

/**
 * Open the editor over the page.
 *
 * @param entries - the rows in force, as stored.
 * @param currency - the currency the rows are written in.
 * @param write - the page's own write path, called with the saved rows.
 */
export function openBillingEditor(entries: readonly string[], currency: string, write: BillingTableWrite) {
  closeBillingEditor()
  const rows: EditRow[] = parseBillingTable(entries).map(row => ({
    model: row.model,
    input: row.cacheMiss === null ? '' : String(row.cacheMiss),
    cacheRead: row.cacheHit === null ? '' : String(row.cacheHit),
    output: row.output === null ? '' : String(row.output),
  }))
  // The names that need a price come first, one blank rate each: a reader who
  // has not filled anything starts from what the tables could not answer.
  const known = new Set(rows.map(row => row.model.toLowerCase()))
  for (const model of unpricedModels()) {
    if (known.has(model.toLowerCase())) continue
    rows.push({ model, input: '', cacheRead: '', output: '' })
  }

  const card = document.createElement('div')
  card.className = 'dsh-claude-billing-card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', '自定义计费表')
  document.body.append(card)
  openCard = card
  card.addEventListener('pointerdown', event => event.stopPropagation())

  const panel = document.createElement('div')
  panel.className = 'dsh-claude-billing-panel'
  card.append(panel)

  const head = document.createElement('header')
  head.className = 'dsh-claude-billing-head'
  panel.append(head)
  const texts = document.createElement('div')
  texts.className = 'dsh-claude-billing-texts'
  head.append(texts)
  const title = document.createElement('h3')
  title.textContent = copy('billingTableTitle')
  texts.append(title)
  const desc = document.createElement('p')
  desc.textContent = copy('billingTableDesc')
  texts.append(desc)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dsh-claude-billing-close'
  close.setAttribute('aria-label', copy('billingTableClose'))
  close.textContent = '✕'
  head.append(close)

  const units = document.createElement('div')
  units.className = 'dsh-claude-billing-units'
  const unitText = document.createElement('span')
  unitText.textContent = copy('billingTableUnit').replace('{currency}', currency)
  units.append(unitText)
  const legend = document.createElement('span')
  legend.textContent = copy('billingTableLegend')
  units.append(legend)
  panel.append(units)

  const grid = document.createElement('div')
  grid.className = 'dsh-claude-billing-grid'
  panel.append(grid)
  const headers = document.createElement('div')
  headers.className = 'dsh-claude-billing-row dsh-claude-billing-row-head'
  for (const label of [copy('billingTableModel'), copy('billingTableCacheRead'), copy('billingTableInput'), copy('billingTableOutput'), '']) {
    const cell = document.createElement('span')
    cell.textContent = label
    headers.append(cell)
  }
  grid.append(headers)

  const body = document.createElement('div')
  body.className = 'dsh-claude-billing-rows'
  grid.append(body)

  const hint = document.createElement('div')
  hint.className = 'dsh-claude-billing-hint'
  hint.textContent = copy('billingTableHint')

  const actions = document.createElement('div')
  actions.className = 'dsh-claude-billing-actions'
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'dsh-claude-billing-add'
  add.textContent = copy('billingTableAdd')
  const limit = document.createElement('span')
  limit.textContent = copy('billingTableLimit').replace('{count}', String(PRICE_ROWS_MAX))
  actions.append(add, limit)
  panel.append(actions)

  const foot = document.createElement('footer')
  foot.className = 'dsh-claude-billing-foot'
  panel.append(hint, foot)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dsh-claude-billing-button'
  cancel.textContent = copy('billingTableCancel')
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'dsh-claude-billing-button dsh-claude-billing-save'
  save.textContent = copy('billingTableSave')
  foot.append(cancel, save)

  const draw = () => {
    while (body.firstChild) body.removeChild(body.firstChild)
    rows.forEach((row, index) => body.append(drawRow(row, index)))
    add.disabled = rows.length >= PRICE_ROWS_MAX
    save.disabled = rows.every(row => row.model.trim() === '')
  }

  const drawRow = (row: EditRow, index: number) => {
    const line = document.createElement('div')
    line.className = 'dsh-claude-billing-row'
    const modelCell = document.createElement('div')
    modelCell.className = 'dsh-claude-billing-model'
    const model = field(row.model, copy('billingTableModel'), 'text')
    model.addEventListener('input', () => { row.model = model.value; save.disabled = rows.every(one => one.model.trim() === '') })
    modelCell.append(model)
    line.append(modelCell)
    for (const key of ['cacheRead', 'input', 'output'] as const) {
      const cell = document.createElement('label')
      cell.className = 'dsh-claude-billing-num'
      const label = document.createElement('span')
      label.textContent = copy(key === 'cacheRead' ? 'billingTableCacheRead' : key === 'input' ? 'billingTableInput' : 'billingTableOutput')
      const input = field(row[key], label.textContent ?? '')
      input.addEventListener('input', () => { row[key] = input.value })
      cell.append(label, input)
      line.append(cell)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'dsh-claude-billing-remove'
    remove.setAttribute('aria-label', copy('billingTableRemove'))
    remove.textContent = '✕'
    remove.addEventListener('click', () => { rows.splice(index, 1); draw() })
    line.append(remove)
    return line
  }

  const field = (value: string, label: string, type = 'text') => {
    const input = document.createElement('input')
    input.className = 'dsh-claude-billing-field'
    input.type = type
    input.value = value
    input.setAttribute('aria-label', label)
    if (type === 'text') input.spellcheck = false
    else input.inputMode = 'decimal'
    return input
  }

  add.addEventListener('click', () => {
    if (rows.length >= PRICE_ROWS_MAX) return
    rows.push({ model: '', input: '', cacheRead: '', output: '' })
    draw()
    const inputs = body.querySelectorAll('.dsh-claude-billing-field')
    const first = inputs.length === 0 ? null : inputs[inputs.length - 3]
    if (first instanceof HTMLInputElement) first.focus()
  })
  close.addEventListener('click', () => closeBillingEditor())
  cancel.addEventListener('click', () => closeBillingEditor())
  save.addEventListener('click', () => {
    const entries: string[] = []
    for (const row of rows) {
      if (row.model.trim() === '') continue
      entries.push(billingRowEntry(row.model, row.input, row.cacheRead, row.output))
    }
    write(entries)
    closeBillingEditor()
  })

  registerPopover('billing-table', closeBillingEditor)
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeBillingEditor()
    }
  })
  draw()
  const firstField = panel.querySelector('input')
  if (firstField instanceof HTMLInputElement) firstField.focus()
}

/** Close the editor, if one stands. */
export function closeBillingEditor() {
  if (openCard === null) return
  const card = openCard
  openCard = null
  card.remove()
  unregisterPopover('billing-table')
}

/** The stored entries one model answers with, used by the settings row's summary. */
export function billingRowsOfEntries(entries: readonly string[]): BillingRow[] {
  return parseBillingTable(entries)
}

/** The four fields of one stored row, for a caller that edits it in place. */
export function billingRowFields(entry: string) {
  return splitBillingRow(entry)
}
