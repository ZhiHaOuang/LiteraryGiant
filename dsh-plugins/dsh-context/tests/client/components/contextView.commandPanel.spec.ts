import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { UseChatLike } from '../../../src/client/services'
import type { CommandRecord, ContextTimeline } from '../../../src/shared/types'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text, until } from '../helpers/kit'
import { makeView, projectionsFor, T0, timeline } from './contextViewHarness'

const req = (seq: number, time: number, extra: Record<string, unknown> = {}) =>
  ({ seq, time, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70, ...extra })

function cmd(seq: number, over: Partial<CommandRecord> = {}): CommandRecord {
  return {
    seq,
    time: T0 + seq * 1000,
    tool: 'bash',
    cmd: 'git status --short',
    description: 'check the tree',
    start: T0 + seq * 1000,
    end: T0 + seq * 1000 + 100,
    status: 'completed',
    err: false,
    ...over,
  }
}

function commandTimeline(commands: CommandRecord[]): ContextTimeline {
  return timeline({
    requests: [
      req(2, T0 + 1000, { turn: 1, step: 1 }),
      req(4, T0 + 3000, { turn: 1, step: 2 }),
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hi', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'on branch main', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
    ],
    commands,
  })
}

async function mountCommands(sessionId: string, commands: CommandRecord[]) {
  const View = makeView(new TestClientCtx())
  const m = await mount(h(View, {
    sessionId,
    useProjection: projectionsFor(commandTimeline(commands)),
    useChat: (sel =>
      sel({
        legacy: { nodes: [] } })) as UseChatLike,
  }))
  const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
  assert.ok(card !== undefined)
  return { m, card }
}

describe('ContextView — command panel', () => {
  test('the panel lists the served commands and reveals the result message in the browser', async () => {
    const { m, card } = await mountCommands('sv-cmds', [cmd(10, { resultSeq: 3 })])
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    const row = query(card, '.lc-cmd-row')
    assert.ok(text(row).includes('git status --short'))
    await click(query(row, '.lc-cmd-time'))
    assert.equal(pick.value, '4', 'the browser lands on the step that first carried the result')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('on branch main'))
    await m.unmount()
  })

  test('a running run without a result is not locatable; a nested run reveals on its parent', async () => {
    const { m, card } = await mountCommands('sv-cmds-nested', [
      cmd(10, { status: 'running', end: undefined }),
      cmd(11, { cmd: 'git diff', codeMode: true, parent: 3, resultSeq: undefined }),
    ])
    const rows = queryAll(card, '.lc-cmd-row')
    const running = rows.find(r => text(r).includes('Running'))
    const nested = rows.find(r => text(r).includes('git diff'))
    assert.ok(running !== undefined && nested !== undefined)
    assert.equal(queryAll(running, '.lc-cmd-time-link').length, 0)
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    await click(query(nested, '.lc-cmd-time'))
    assert.equal(pick.value, '4', 'the nested run reveals its run_code parent')
    await m.unmount()
  })

  test('the card follows the detail channel states', async () => {
    const { m } = await mountCommands('sv-cmds-none', [])
    assert.ok(text(m.container).includes('No commands executed in this session'))
    await m.unmount()
  })

  test('the split generation serves the command log through the detail channel', async () => {
    const rich = commandTimeline([cmd(10, { resultSeq: 3 })])
    const head = timeline({
      counts: { turns: 1, steps: 2, injects: 0, compactions: 0, prunes: 0 },
      detailRev: 2,
    })
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if ('beforeSeq' in body) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { commands: [], atStart: true, total: 1 } }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 2,
            requests: rich.requests,
            events: rich.events,
            nodes: rich.nodes,
            droppedNodes: rich.droppedNodes,
            archive: rich.archive,
            commands: rich.commands,
            commandsFloor: 1,
            commandStats: { runs: 42, failed: 2, ms: 9100, bg: 0 },
          },
        }),
      }
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-cmds-split', useProjection: projectionsFor(head) }))
    try {
      await until(() => queryAll(m.container, '.lc-cmd-row').length === 1, 'the detail never landed')
      const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
      assert.ok(card !== undefined)
      const kpi = query(card, '.lc-cmd-kpi b')
      assert.ok(kpi !== undefined && text(kpi) === '42', 'the whole-log tally rides the detail')
      await until(() => queryAll(card, '.lc-cmd-floor').length === 0, 'the history fill never completed')
      assert.ok(!text(card).includes('Covering'), 'a completed fill drops the floor note')
    } finally {
      await m.unmount()
    }
  })

  test('a run whose result was compacted away before any step carried it cannot be located', async () => {
    const View = makeView(new TestClientCtx())
    const goneTimeline = {
      ...commandTimeline([cmd(10, { resultSeq: 99 })]),
      archive: [{ seq: 99, cat: 'tool' as const, tokens: 30, tool: 'bash', gone: 6, time: T0 + 2000 }],
    }
    const m = await mount(h(View, {
      sessionId: 'sv-cmds-gone',
      useProjection: projectionsFor(goneTimeline),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
      assert.ok(card !== undefined)
      const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
      await click(query(card, '.lc-cmd-time'))
      assert.equal(pick.value, 'live')
    } finally {
      await m.unmount()
    }
  })
})
