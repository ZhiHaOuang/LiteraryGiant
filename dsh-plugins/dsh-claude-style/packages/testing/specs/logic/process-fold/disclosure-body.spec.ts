/**
 * Which element a disclosure control opens: the fold glide presses the body a
 * host row discloses, wherever the host build puts it relative to the row.
 *
 * @capability process-fold
 * @features chat-fold
 * @risk Opening or folding a thinking row animates the wrong element: the accessory beside the row, or a neighbouring control's content, slides instead of the reasoning body.
 */
import { afterEach, expect, test } from 'vitest'
import { foldExpandedBody } from '@dsh-claude-style/client/pure'
import { DISCLOSURE_HEADER_SELECTOR, DISCLOSURE_ROW_SELECTOR, FOLD_TOGGLE_SELECTOR } from '@dsh-claude-style/contracts/dom'
import { hostElement } from '../../fixtures/host-markup'

afterEach(() => {
  document.body.replaceChildren()
})

/** A row family attached to the page, built from the contract's own selectors. */
function family(...nodes: Element[]) {
  const root = document.createElement('div')
  root.append(...nodes)
  document.body.append(root)
  return root
}

const row = () => hostElement(DISCLOSURE_ROW_SELECTOR)
const header = (...children: Element[]) => {
  const element = hostElement(DISCLOSURE_HEADER_SELECTOR)
  element.append(...children)
  return element
}
const box = () => document.createElement('div')

test('a row with no header wrapper: the open body is the sibling after the row, the closed family has none', () => {
  const openRow = row()
  const body = box()
  family(openRow, body)
  expect(foldExpandedBody(openRow)).toBe(body)
  const closedRow = row()
  family(closedRow)
  expect(foldExpandedBody(closedRow)).toBeNull()
})

test('a row whose family nests the body in the wrapper the row itself lives in', () => {
  const openRow = row()
  const body = box()
  const open = box()
  open.append(header(openRow), body)
  family(open)
  expect(foldExpandedBody(openRow)).toBe(body)
  const closedRow = row()
  const closed = box()
  closed.append(header(closedRow))
  family(closed)
  expect(foldExpandedBody(closedRow)).toBeNull()
})

test('a row inside a header wrapper: the open body is the sibling after the wrapper', () => {
  const openRow = row()
  const body = box()
  family(header(openRow), body)
  expect(foldExpandedBody(openRow)).toBe(body)
  const closedRow = row()
  family(header(closedRow))
  expect(foldExpandedBody(closedRow)).toBeNull()
})

test('the accessory beside a wrapped row is never taken for its body', () => {
  const closedRow = row()
  family(header(closedRow, document.createElement('span')))
  expect(foldExpandedBody(closedRow)).toBeNull()
  const openRow = row()
  const body = box()
  family(header(openRow, document.createElement('span')), body)
  expect(foldExpandedBody(openRow)).toBe(body)
})

test('a control inside the header that is not the row keeps to its own siblings', () => {
  const toggle = hostElement(FOLD_TOGGLE_SELECTOR, 'false')
  family(header(row(), toggle), box())
  expect(foldExpandedBody(toggle)).toBeNull()
})

test('a control naming its body with aria-controls gets that body wherever it stands', () => {
  const named = row()
  named.setAttribute('aria-controls', ':r1:')
  const body = document.createElement('section')
  body.id = ':r1:'
  family(header(named), box(), body)
  expect(foldExpandedBody(named)).toBe(body)
})
