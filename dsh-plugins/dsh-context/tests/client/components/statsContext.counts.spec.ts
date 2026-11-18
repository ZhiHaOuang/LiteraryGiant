import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { countsOfRecords, toolTallyOf } from '../../../src/client/components/statsContext'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../../src/shared/types'

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

function skillEv(name: string): ContextEventRecord {
  return { seq: 0, time: 0, kind: 'inject', form: 'instructions', sub: 'skill', name }
}

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, the three priced event kinds, and the distinct loaded skills', () => {
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [
        ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode'),
        skillEv('grilling'), skillEv('grilling'), skillEv('ponytail'),
        { ...ev('inject'), name: 'available-skills' },
        { ...ev('inject'), sub: 'skill' },
        { ...ev('inject'), sub: 'skill', name: 5 } as unknown as ContextEventRecord,
      ],
    )
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 9, compactions: 2, prunes: 1, skills: 2 })
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
  })
})

describe('toolTallyOf (the live-surface per-tool tally)', () => {
  const node = (cat: SurfaceNode['cat'], tool?: string): SurfaceNode => ({ seq: 0, cat, tokens: 0, ...(tool !== undefined ? { tool } : {}) })

  test('folds the host predicate: tool results, plus skill nodes carrying a tool', () => {
    const tally = toolTallyOf([
      node('tool', 'read'), node('tool', 'read'), node('tool', 'bash'),
      node('skill', 'run_code'),
      node('skill'),
      node('user'), node('assistant'),
      node('tool'),
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1], ['run_code', 1]])
  })

  test('sorts count-desc then name-asc, ties breaking name-asc in either insertion order, skipping hostile shapes', () => {
    const tally = toolTallyOf([
      node('tool', 'bash'), node('tool', 'read'), node('tool', 'read'),
      { seq: 0, cat: 'tool', tokens: 0, tool: 5 } as unknown as SurfaceNode,
      node('tool', ''),
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1]])
    assert.deepEqual(toolTallyOf([node('tool', 'zed'), node('tool', 'apple')]), [['apple', 1], ['zed', 1]])
    assert.deepEqual(toolTallyOf([node('tool', 'apple'), node('tool', 'zed')]), [['apple', 1], ['zed', 1]])
  })
})

