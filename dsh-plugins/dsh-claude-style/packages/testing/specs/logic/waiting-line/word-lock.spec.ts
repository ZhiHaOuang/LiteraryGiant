/**
 * How long a wording stands on the waiting line: a wording written stands a
 * whole second, a call stepped over by that lock waits and is written ahead of
 * the state, and the model's own clause stands until the next intent.
 *
 * @capability waiting-line
 * @features chat-wait
 * @risk The line under a running answer flickers between wordings several times a second, drops the file a call touched, or falls back to the brand's word between two clauses of the model's own.
 */
import { expect, test } from 'vitest'
import fc from 'fast-check'
import { WORD_LOCK_MS, wordForPass } from '@dsh-claude-style/client/pure'

const quiet = { word: null, own: false, detail: null, onCall: false, host: 'Deep diving' }
const thinking = { word: 'Thinking…', own: false, detail: null, onCall: false, host: 'Deep diving' }
const preparing = { word: 'Preparing a tool call…', own: false, detail: null, onCall: true, host: 'Deep diving' }
const read = { word: 'Reading app.js', own: false, detail: 'Reading app.js', onCall: false, host: 'Deep diving' }
const edit = { word: 'Editing notes.md', own: false, detail: 'Editing notes.md', onCall: false, host: 'Deep diving' }
const clause = { word: 'Checking the row model', own: true, detail: null, onCall: false, host: 'Deep diving' }
const writing = { word: 'Writing…', own: false, detail: null, onCall: false, host: 'Deep diving' }

test('a wording written stands a whole second; the newest state after it is written at once', () => {
  const first = wordForPass(read, undefined, 1000)
  expect(first).toEqual({ word: 'Reading app.js', row: { standing: { word: 'Reading app.js', until: 1000 + WORD_LOCK_MS } } })
  // Inside the second the newest state waits, however many arrive.
  expect(wordForPass(thinking, first.row, 1200)).toEqual({ word: 'Reading app.js', row: first.row })
  expect(wordForPass(quiet, first.row, 1900)).toEqual({ word: 'Reading app.js', row: first.row })
  // Past it, whatever the state says then is written, and a new second starts.
  const next = wordForPass(thinking, first.row, 1000 + WORD_LOCK_MS + 1)
  expect(next.word).toBe('Thinking…')
  expect(next.row).toEqual({ standing: { word: 'Thinking…', until: 1000 + WORD_LOCK_MS + 1 + WORD_LOCK_MS } })
  // A wording the state still asks for keeps its old lock, so a state that stayed put cannot hold the line.
  const held = wordForPass(thinking, next.row, 1000 + WORD_LOCK_MS + 900)
  expect(held).toEqual({ word: 'Thinking…', row: next.row })
  expect(wordForPass(read, held.row, 1000 + WORD_LOCK_MS + 900 + 200).word).toBe('Reading app.js')
  // Nothing readable and nothing locked: the host's own words.
  expect(wordForPass(quiet, undefined, 1000).word).toBe('Deep diving')
})

test('a call the lock stepped over waits for it and is written ahead of the state', () => {
  const first = wordForPass(thinking, undefined, 1000)
  const waiting = wordForPass(read, first.row, 1300)
  expect(waiting.word).toBe('Thinking…')
  expect(waiting.row.pending).toBe('Reading app.js')
  // Another call inside the same second takes its place: only the newest waits.
  const second = wordForPass(edit, waiting.row, 1500)
  expect(second.row.pending).toBe('Editing notes.md')
  // The lock ends: the call that waited is written, not the state of that moment.
  const written = wordForPass(quiet, second.row, 1000 + WORD_LOCK_MS + 1)
  expect(written.word).toBe('Editing notes.md')
  expect(written.row.pending).toBeUndefined()
  // A call being drawn up after it does not stand behind the file: that is newer work.
  const late = wordForPass(read, written.row, 2100)
  expect(late.row.pending).toBe('Reading app.js')
  expect(wordForPass(preparing, late.row, 2200).row.pending).toBeUndefined()
  expect(wordForPass(preparing, late.row, 2200 + WORD_LOCK_MS).word).toBe('Preparing a tool call…')
})

test('the model\'s own words stand until the next intent, through the reasoning that says nothing', () => {
  const first = wordForPass(clause, undefined, 1000)
  expect(first).toEqual({
    word: 'Checking the row model',
    row: { standing: { word: 'Checking the row model', until: 1000 + WORD_LOCK_MS }, held: 'Checking the row model' },
  })
  const between = wordForPass(quiet, first.row, 1000 + WORD_LOCK_MS + 1)
  expect(between.word).toBe('Checking the row model')
  expect(between.row.held).toBe('Checking the row model')
  // A state the line can read is newer work: it takes the line, and the clause does not come back.
  const state = wordForPass(writing, between.row, 1000 + WORD_LOCK_MS + 200)
  expect(state.word).toBe('Writing…')
  expect(state.row.held).toBeUndefined()
  const silent = wordForPass(quiet, state.row, 1000 + WORD_LOCK_MS + 200 + WORD_LOCK_MS + 1)
  expect(silent.word).toBe('Deep diving')
  // The waiting word holds its own second like any other wording.
  const newer = wordForPass({ ...clause, word: 'Reading the row model' }, silent.row, 1000 + WORD_LOCK_MS + 200 + WORD_LOCK_MS * 2 + 2)
  expect(newer.word).toBe('Reading the row model')
  expect(newer.row.held).toBe('Reading the row model')
})

test('over any run of passes the line never changes twice within one lock', () => {
  const readings = fc.array(fc.tuple(fc.constantFrom(quiet, thinking, preparing, read, edit, clause, writing), fc.integer({ min: 1, max: 700 })), { minLength: 1, maxLength: 40 })
  fc.assert(fc.property(readings, (passes) => {
    let now = 1000
    let row = undefined as Parameters<typeof wordForPass>[1]
    let shown: string | null = null
    let shownAt = -Infinity
    for (const [reading, gap] of passes) {
      now += gap
      const pass = wordForPass(reading, row, now)
      row = pass.row
      if (pass.word !== shown) {
        // A change of wording is only ever written once the last one has stood its second.
        if (shown !== null) expect(now - shownAt).toBeGreaterThanOrEqual(WORD_LOCK_MS)
        shown = pass.word
        shownAt = now
      }
    }
  }))
})
