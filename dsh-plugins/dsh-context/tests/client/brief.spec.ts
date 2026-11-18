import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { briefNodes, briefOf } from '../../src/client/brief'
import type { ContextTimeline, RequestRecord, SurfaceNode } from '../../src/shared/types'
import { surfaceNodeAt } from './helpers/kit'

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function timeline(nodes: SurfaceNode[], archive: SurfaceNode[]): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes,
    droppedNodes: 0,
    archive,
  }
}

describe('briefNodes', () => {
  test('merges live and archived nodes sorted by seq; an out-of-range index yields no brief', () => {
    const data = timeline([surfaceNodeAt(5), surfaceNodeAt(1)], [surfaceNodeAt(3, { gone: 9 }), surfaceNodeAt(2, { gone: 9 })])
    assert.deepEqual(briefNodes(data).map(n => n.seq), [1, 2, 3, 5])
    assert.equal(briefOf([], [req(1)], -1), null)
    assert.equal(briefOf([], [req(1)], 1), null)
  })
})

describe('briefOf response', () => {
  test('only an assistant node at the request seq is a response', () => {
    const nodes = [surfaceNodeAt(5, { cat: 'assistant', text: 'hi' })]
    assert.equal(briefOf(nodes, [req(5, { turn: 1 })], 0)?.response, nodes[0])
    assert.equal(briefOf([surfaceNodeAt(5)], [req(5, { turn: 1 })], 0)?.response, undefined, 'a non-assistant node is not a response')
    assert.equal(briefOf([surfaceNodeAt(4)], [req(5, { turn: 1 })], 0)?.response, undefined, 'no node at the seq means no response')
  })
})

describe('briefOf opener scan', () => {
  test('the opener is the newest user message before the turn starts, scoped to the turn window', () => {
    const nodes = [surfaceNodeAt(1), surfaceNodeAt(2), surfaceNodeAt(3, { cat: 'tool' }), surfaceNodeAt(5, { cat: 'assistant' })]
    assert.equal(briefOf(nodes, [req(5, { turn: 1 })], 0)?.opener, nodes[1])
    assert.equal(briefOf([surfaceNodeAt(3, { cat: 'tool' }), surfaceNodeAt(5, { cat: 'assistant' })], [req(5, { turn: 1 })], 0)?.opener, undefined, 'no user message in the window')
    const turnNodes = [surfaceNodeAt(1), surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(5, { cat: 'tool' }), surfaceNodeAt(7, { cat: 'assistant' })]
    const turnRequests = [req(3, { turn: 1 }), req(7, { turn: 2 })]
    assert.equal(briefOf(turnNodes, turnRequests, 1)?.opener, undefined, 'the scan stops at the previous turn’s last bar')
    const later = [surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(5), surfaceNodeAt(7, { cat: 'assistant' })]
    assert.equal(briefOf(later, turnRequests, 1)?.opener, later[1], 'a user message inside the later turn’s window is found')
  })
})

describe('briefOf inputs', () => {
  test('a mid-turn step collects the nodes since the previous bar, up to the request seq', () => {
    const nodes = [surfaceNodeAt(2), surfaceNodeAt(3, { cat: 'assistant' }), surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(5), surfaceNodeAt(7, { cat: 'assistant' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    assert.deepEqual(briefOf(nodes, requests, 1)?.inputs.map(n => n.seq), [4, 5])
    const tail = [surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(9, { cat: 'tool' })]
    const tailRequests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    assert.deepEqual(briefOf(tail, tailRequests, 1)?.inputs.map(n => n.seq), [4], 'the scan stops at the request seq even past the node tail')
  })

  test('a turn start and a missing previous turn field both yield no inputs row; requests without turn fields share the default turn', () => {
    assert.deepEqual(briefOf([surfaceNodeAt(4, { cat: 'tool' }), surfaceNodeAt(5)], [req(3, { turn: 1 }), req(7, { turn: 2 })], 1)?.inputs, [])
    assert.deepEqual(briefOf([], [req(3), req(7, { turn: 2 })], 1)?.inputs, [])
    assert.deepEqual(briefOf([surfaceNodeAt(4, { cat: 'tool' })], [req(3), req(7)], 1)?.inputs.map(n => n.seq), [4])
  })
})
