import { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { WiredProjection } from './projection'
import { BASELINE_DSH_VERSION } from '../shared/version'
import { contextActivitySchema } from './activity'
import { contextHeadersSchema } from './headers'
import { contextTimelineSchema } from './timeline'

const fallbackStateSchema = z.object({})
type FallbackState = z.infer<typeof fallbackStateSchema>

type FallbackDefinition<K extends keyof SessionProjectionMap> = WiredProjection<K, FallbackState> & {
  schema: z.ZodType<SessionProjectionMap[K]>
  view(state: FallbackState): SessionProjectionMap[K]
}

function fallbackDefinition<K extends 'contextTimeline' | 'contextHeaders' | 'contextActivity'>(
  key: K,
  wireSchema: z.ZodType<SessionProjectionMap[K]>,
  value: SessionProjectionMap[K],
): FallbackDefinition<K> {
  const view = (): SessionProjectionMap[K] => value
  return {
    key,
    stateSchema: fallbackStateSchema,
    init: () => ({}),
    apply: state => state,
    wire: { viewSchema: wireSchema, view },
    schema: wireSchema,
    view,
    stateVersion: 1,
  }
}

export function createFallbackTimelineDefinition(current: string) {
  return fallbackDefinition('contextTimeline', contextTimelineSchema, {
    ok: true,
    unsupported: { current, minimum: BASELINE_DSH_VERSION },
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  })
}

export function createFallbackHeadersDefinition() {
  return fallbackDefinition('contextHeaders', contextHeadersSchema, { headers: [] })
}

export function createFallbackActivityDefinition() {
  return fallbackDefinition('contextActivity', contextActivitySchema, { days: {} })
}
