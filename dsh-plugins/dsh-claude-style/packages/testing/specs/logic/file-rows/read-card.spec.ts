/**
 * The file row's read card: a read, edit or write call maps to its operation
 * and the host's own title, and a read's result becomes the window of lines the
 * row shows — from the call's own metadata, or from the model-facing envelope
 * where a sub-call carries none.
 *
 * @capability file-rows
 * @features chat-files
 * @risk A file the model read shows the wrong lines or wrong line numbers, or a result that is not a read is drawn as a file window.
 */
import { expect, test } from 'vitest'
import { fileToolOperation, chatFileOperationTitle, chatFileReadCard, chatFileReadEnvelope, chatFileReadMeta } from '@dsh-claude-style/client/pure'
import type { HostChatBlock } from '@dsh-claude-style/contracts/services'

/** One settled read result: its arguments, its single text block and its own metadata. */
function readResult(text: string, meta?: unknown): HostChatBlock {
  return {
    kind: 'tool-result',
    call: { name: 'read', argsRaw: JSON.stringify({ file_path: 'C:\\work\\app.js' }) },
    content: [{ type: 'text', text }],
    isError: false,
    meta,
  }
}

/** The model-facing read envelope one window is written into (dsh-tool-fs's formatReadOutput). */
function envelope(body: string, path = 'app.js') {
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

test('the three tools that touch a file map to their own operation, and anything else to none', () => {
  expect(fileToolOperation('read')).toBe('read')
  expect(fileToolOperation('edit')).toBe('edit')
  expect(fileToolOperation('write')).toBe('write')
  expect(fileToolOperation('bash')).toBe(null)
  expect(fileToolOperation('read_image')).toBe(null)
})

test('each operation reads the host\'s own title key', () => {
  expect(chatFileOperationTitle('read')).toBe('tool.title.read')
  expect(chatFileOperationTitle('edit')).toBe('tool.title.edit')
  expect(chatFileOperationTitle('write')).toBe('tool.title.write')
})

test('a call\'s own metadata gives the window the host validates', () => {
  const card = chatFileReadMeta({
    path: 'C:\\work\\app.js',
    offset: 3,
    lines: [{ number: 3, text: 'const a = 1' }, { number: 4, text: 'const b = 2' }],
    totalLines: 9,
    lang: 'javascript',
  })
  expect(card).toEqual({
    path: 'C:\\work\\app.js',
    lines: [{ number: 3, text: 'const a = 1' }, { number: 4, text: 'const b = 2' }],
    totalLines: 9,
    lang: 'javascript',
  })
})

test('metadata that would misnumber or overcount its lines declines', () => {
  expect(chatFileReadMeta({ path: 'app.js', offset: 0, lines: [], totalLines: 3 })).toBe(null)
  expect(chatFileReadMeta({ path: 'app.js', offset: 1, lines: [{ number: 2, text: 'a' }, { number: 2, text: 'b' }], totalLines: 3 })).toBe(null)
  expect(chatFileReadMeta({ path: 'app.js', offset: 1, lines: [{ number: 9, text: 'a' }], totalLines: 3 })).toBe(null)
  expect(chatFileReadMeta({ path: 'app.js', offset: 1, lines: [{ number: 1, text: 7 }], totalLines: 3 })).toBe(null)
  expect(chatFileReadMeta({ path: 'app.js', offset: 1, lines: [], totalLines: -1 })).toBe(null)
  expect(chatFileReadMeta('app.js')).toBe(null)
})

test('a whole-file read envelope reads back with its lines and its total', () => {
  const card = chatFileReadEnvelope(envelope('1: const a = 1\n2: const b = 2\n\n(End of file - total 2 lines)'), 'app.js')
  expect(card).toEqual({
    path: 'app.js',
    lines: [{ number: 1, text: 'const a = 1' }, { number: 2, text: 'const b = 2' }],
    totalLines: 2,
  })
})

test('a windowed read envelope keeps the file\'s own line numbers and its total', () => {
  const card = chatFileReadEnvelope(envelope('5: const e = 5\n6: const f = 6\n\n(Showing lines 5-6 of 40. Use offset=7 to continue.)'), 'app.js')
  expect(card?.lines).toEqual([{ number: 5, text: 'const e = 5' }, { number: 6, text: 'const f = 6' }])
  expect(card?.totalLines).toBe(40)
})

test('a byte-capped read envelope falls back to its last line number for the total', () => {
  const card = chatFileReadEnvelope(envelope('1: const a = 1\n2: const b = 2\n\n(Output capped. Showing lines 1-2. Use offset=3 to continue.)'), 'app.js')
  expect(card?.totalLines).toBe(2)
})

test('a read of an empty file still carries its total', () => {
  expect(chatFileReadEnvelope(envelope('(End of file - total 0 lines)'), 'app.js')).toEqual({ path: 'app.js', lines: [], totalLines: 0 })
})

test('a line holding a colon reads as the file\'s own text', () => {
  const card = chatFileReadEnvelope(envelope('7: label: value\n\n(End of file - total 7 lines)'), 'app.js')
  expect(card?.lines).toEqual([{ number: 7, text: 'label: value' }])
})

test('text that is not a read envelope declines', () => {
  expect(chatFileReadEnvelope('ok', 'app.js')).toBe(null)
  expect(chatFileReadEnvelope(envelope('1: a\n\n(End of file - total 1 lines)\ntrailing'), 'app.js')).toBe(null)
  expect(chatFileReadEnvelope(envelope('not a numbered line'), 'app.js')).toBe(null)
})

test('a read row takes its own metadata first and the envelope where a sub-call has none', () => {
  const body = '1: const a = 1\n\n(End of file - total 1 lines)'
  const own = chatFileReadCard(readResult(envelope(body), { path: 'C:\\work\\app.js', offset: 1, lines: [{ number: 1, text: 'const a = 1' }], totalLines: 4 }), 'C:\\work\\app.js')
  expect(own?.totalLines).toBe(4)
  const derived = chatFileReadCard(readResult(envelope(body)), 'C:\\work\\app.js')
  expect(derived).toEqual({ path: 'C:\\work\\app.js', lines: [{ number: 1, text: 'const a = 1' }], totalLines: 1 })
  expect(chatFileReadCard({ ...readResult(envelope(body)), isError: true }, 'app.js')).toBe(null)
  expect(chatFileReadCard({ ...readResult(envelope(body)), content: [{ type: 'text', text: body }, { type: 'text', text: 'more' }] }, 'app.js')).toBe(null)
  expect(chatFileReadCard(readResult('ok'), 'app.js')).toBe(null)
})
