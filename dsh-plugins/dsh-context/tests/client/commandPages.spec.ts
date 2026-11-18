import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { COMMANDS_ROUTE } from '../../src/client/apiRoutes'
import { commandPageOf, makeCommandPager } from '../../src/client/commandPages'

afterEach(() => { vi.unstubAllGlobals() })

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false, ...over }
}

describe('commandPageOf', () => {
  test('proves every field and keeps the valid optionals', () => {
    const page = commandPageOf({
      commands: [record({
        resultSeq: 2, parent: 3, turn: 1, step: 2, end: 11, exit: 0, outChars: 5, timeoutMs: 9, gone: 4,
        description: 'list', cwd: '/repo', sandbox: 'danger-full-access', signal: 'SIGKILL',
        cmdTruncated: true, background: true, codeMode: true, exitInferred: true, timedOut: true,
        stopped: true, denied: true, outTruncated: true, stderr: true, derived: true,
      })],
      atStart: false,
      total: 7,
    })
    assert.deepEqual(page, {
      commands: [{
        seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false,
        resultSeq: 2, parent: 3, turn: 1, step: 2, end: 11, exit: 0, outChars: 5, timeoutMs: 9, gone: 4,
        description: 'list', cwd: '/repo', sandbox: 'danger-full-access', signal: 'SIGKILL',
        cmdTruncated: true, background: true, codeMode: true, exitInferred: true, timedOut: true,
        stopped: true, denied: true, outTruncated: true, stderr: true, derived: true,
      }],
      atStart: false,
      total: 7,
    })
  })

  test('drops wrong-typed optionals and skips entries that fail the core shape', () => {
    const page = commandPageOf({
      commands: [
        record({ resultSeq: '2', parent: Number.NaN, turn: Infinity, step: '1', end: null, exit: 'zero', outChars: '9', gone: {}, description: 4, cwd: null, sandbox: 2, signal: [], cmdTruncated: 1, background: 'yes', derived: false }),
        null,
        42,
        record({ cmd: undefined }),
        record({ status: 'exploded' }),
        record({ err: 'no' }),
        record({ seq: '1' }),
        record({ time: null }),
        record({ start: 'x' }),
        record({ tool: 7 }),
        record({ seq: 2 }),
      ],
      atStart: true,
      total: 11,
    })
    assert.deepEqual(page?.commands, [
      { seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false },
      { seq: 2, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false },
    ])
    assert.equal(page?.total, 11, 'the page total counts the log, not the readable entries')
  })

  test('rejects a page whose envelope fails the shape', () => {
    for (const value of [
      null,
      42,
      {},
      { atStart: true, commands: [] },
      { atStart: 'yes', commands: [], total: 0 },
      { atStart: true, commands: {}, total: 0 },
      { atStart: true, commands: [], total: -1 },
      { atStart: true, commands: [], total: Number.NaN },
      { atStart: true, commands: [], total: '3' },
    ]) assert.equal(commandPageOf(value), null, `rejected ${JSON.stringify(value)}`)
  })
})

describe('makeCommandPager', () => {
  test('an empty session id arms nothing', () => {
    assert.equal(makeCommandPager(''), undefined)
  })

  test('posts the read and re-proves the reply', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { commands: [record()], atStart: true, total: 1 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pager = makeCommandPager('s1', 7)
    assert.ok(pager !== undefined)
    const page = await pager(12)
    assert.deepEqual(page?.commands.map(c => c.seq), [1])
    assert.equal(fetchMock.mock.calls.length, 1)
    const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    assert.equal(route, COMMANDS_ROUTE)
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(String(init.body)), { sessionId: 's1', beforeSeq: 12, limit: 7 })
  })

  test('the page size stays a host policy unless one is given', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { commands: [record()], atStart: true, total: 1 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    await pager(3)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    assert.deepEqual(JSON.parse(String(init.body)), { sessionId: 's1', beforeSeq: 3 })
  })

  test('the route\'s null answer stays null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    assert.equal(await pager(0), null)
  })

  test('every transport or shape failure rejects', async () => {
    const cases: unknown[] = [
      { ok: false, status: 502, json: async () => ({ ok: true, value: null }) },
      { ok: true, status: 200, json: async () => null },
      { ok: true, status: 200, json: async () => ({ ok: false }) },
      { ok: true, status: 200, json: async () => ({ ok: true, value: { atStart: true, commands: [], total: 'x' } }) },
    ]
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    for (const response of cases) {
      vi.stubGlobal('fetch', async () => response)
      await assert.rejects(pager(0))
    }
  })
})
