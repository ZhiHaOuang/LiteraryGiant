/**
 * What the waiting line says the model is doing, read off the host's chat
 * snapshot: thinking, drawing up a call, writing, running tools or touching a
 * named file — and the brand's own word where nothing can be read.
 *
 * @capability waiting-line
 * @features chat-wait, shared
 * @risk The line under a running answer claims the model is writing while it thinks, names a file from another turn, or shows the host's word under the Claude brand.
 */
import { expect, test } from 'vitest'
import { ACTIVITY_THINKING, activityWords, openTurn, waitStart, waitingWord } from '@dsh-claude-style/client/pure'
import { BRAND_CLAUDE, BRAND_DEEPSEEK } from '@dsh-claude-style/contracts/prefs'
import type { HostChatSnapshot, HostTurn } from '@dsh-claude-style/contracts/services'

function step(status: string, blocks: (string | { kind: string, text: string })[]) {
  const assistant = { status, blocks: blocks.map(block => typeof block === 'string' ? { kind: block } : block) }
  return { data: { get: (kind: string) => kind === 'assistant-step' ? assistant : undefined } }
}

function turn(number: number, status: string, steps: ReturnType<typeof step>[], start = 1000): HostTurn {
  return { turn: number, status, steps, start: { time: start } }
}

function snapshot(turns: HostTurn[], runningCalls: object[] = []): HostChatSnapshot {
  return { timeline: { turns: new Map(turns.map(entry => [entry.turn, entry])), turnOrder: turns.map(entry => entry.turn) }, legacy: { runningCalls } } as HostChatSnapshot
}

test('no state can be read before any step, and while a started step has written nothing', () => {
  const fresh = turn(1, 'open', [])
  expect(activityWords(snapshot([fresh]), fresh, true)).toBeNull()
  const started = turn(1, 'open', [step('running', [])])
  expect(activityWords(snapshot([started]), started, true)).toBeNull()
  expect(activityWords(null, fresh, true)).toBeNull()
  expect(activityWords(snapshot([fresh]), undefined, true)).toBeNull()
})

test('the newest block says what the model is doing: thinking, drawing up a call, writing', () => {
  const thinking = turn(1, 'open', [step('running', ['reasoning'])])
  expect(activityWords(snapshot([thinking]), thinking, true)).toBe(ACTIVITY_THINKING)
  const drawing = turn(1, 'open', [step('running', ['reasoning', 'tool-call'])])
  expect(activityWords(snapshot([drawing]), drawing, true)?.key).toBe('chatWaitToolCall')
  const writing = turn(1, 'open', [step('running', ['reasoning', 'tool-call', 'text'])])
  expect(activityWords(snapshot([writing]), writing, true)?.key).toBe('chatWaitWriting')
})

test('a running tool call is its own state, and one from another turn does not count', () => {
  const tooling = turn(1, 'open', [step('settled', ['reasoning', 'tool-call'])])
  expect(activityWords(snapshot([tooling], [{ turn: 1 }]), tooling, true)?.key).toBe('chatWaitTools')
  expect(activityWords(snapshot([tooling], [{ turn: 2 }]), tooling, true)).toBeNull()
})

test('a running call names its file, and the newest of several calls names the line', () => {
  const tooling = turn(1, 'open', [step('settled', ['reasoning', 'tool-call'])])
  const read = { turn: 1, phase: 'start', name: 'read', argsRaw: '{"file_path":"C:\\\\work\\\\app.js"}' }
  const edit = { turn: 1, phase: 'start', name: 'edit', argsRaw: '{"file_path":"/work/notes.md"}' }
  const words = activityWords(snapshot([tooling], [read]), tooling, true)
  expect(words?.key).toBe('chatWaitReading')
  expect(words?.params).toEqual({ file: 'app.js' })
  expect(activityWords(snapshot([tooling], [read, edit]), tooling, true)?.params).toEqual({ file: 'notes.md' })
})

test('a call that names no file keeps the tool state, and one still arriving names nothing yet', () => {
  const tooling = turn(1, 'open', [step('settled', ['reasoning', 'tool-call'])])
  const command = { turn: 1, phase: 'start', name: 'pwsh', argsRaw: '{"command":"ls"}' }
  const arriving = { turn: 1, phase: 'preparing', name: 'read', argsRaw: '{"file_path":"app' }
  expect(activityWords(snapshot([tooling], [command]), tooling, true)?.key).toBe('chatWaitTools')
  expect(activityWords(snapshot([tooling], [arriving]), tooling, true)?.key).toBe('chatWaitTools')
})

test('reasoning that says what it is doing hands the line its own clause', () => {
  const thinking = turn(1, 'open', [step('running', [{ kind: 'reasoning', text: 'Let me look. I am checking the file is true. ' }])])
  const words = activityWords(snapshot([thinking]), thinking, true)
  expect(words?.key).toBeNull()
  expect(words?.text).toBe('Checking the file is true')
  const quiet = turn(1, 'open', [step('running', [{ kind: 'reasoning', text: '先看清工作区。' }])])
  expect(activityWords(snapshot([quiet]), quiet, true)).toBe(ACTIVITY_THINKING)
})

test('the first wait of a turn counts from its start, a later one from when it was seen', () => {
  expect(waitStart(turn(1, 'open', [], 1000), 5000)).toBe(1000)
  expect(waitStart(turn(1, 'open', [step('running', [])], 1000), 5000)).toBe(1000)
  expect(waitStart(turn(1, 'open', [step('settled', ['tool-call']), step('running', [])], 1000), 5000)).toBe(5000)
})

test('the running row speaks for the newest open turn', () => {
  const closed = turn(1, 'closed', [])
  const open = turn(2, 'open', [])
  expect(openTurn(snapshot([closed, open]))).toBe(open)
  expect(openTurn(snapshot([closed]))).toBeUndefined()
})

test('the one word a wait stands on is the brand\'s own, whichever word the host would have said', () => {
  // Claude: the skin's own word, so a wait does not change places when its state stops being readable.
  expect(waitingWord(BRAND_CLAUDE, 'Deep diving', 'Thinking…')).toBe('Thinking…')
  expect(waitingWord(BRAND_CLAUDE, '深度求索中', 'Thinking…')).toBe('Thinking…')
  // DeepSeek: the host's own word, in the host's own language.
  expect(waitingWord(BRAND_DEEPSEEK, 'Deep diving', 'Thinking…')).toBe('Deep diving')
  expect(waitingWord(BRAND_DEEPSEEK, '深度求索中', 'Thinking…')).toBe('深度求索中')
})
