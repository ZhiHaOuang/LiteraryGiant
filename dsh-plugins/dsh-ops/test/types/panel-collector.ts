import fs from 'node:fs'
import { createPanelCollector, fitDocument, foldRecords, parseAppendLog, projectEvent, resolvePanelConfig } from '../../src/panel/collect.js'
import type { CaptureEvent, PanelIO } from '../../src/panel/types.js'

declare const raw: unknown
const config = resolvePanelConfig(raw)
const io: PanelIO = fs.promises
const collector = createPanelCollector({ config, io })
collector.observe(raw, raw)
const stopped: Promise<void> = collector.stop()
const projected = projectEvent(raw)
if (projected) {
  const seq: number = projected.seq
  void seq
}
const parsed = parseAppendLog('{}\n')
// @ts-expect-error JSON object properties remain unknown until validated.
const unsafeCount: number = parsed.records[0]!.count
// @ts-expect-error A configured byte budget must be numeric.
createPanelCollector({ config: { capture: true, textLimit: 64, maxSessionBytes: '65536' } })
// @ts-expect-error Configuration is immutable after validation.
config.capture = false
// @ts-expect-error Lifecycle identities are strings.
collector.close(12)
// @ts-expect-error A persisted event's usage totals must be numbers.
const badEvent: CaptureEvent = { seq: 0, time: 1, type: 'assistant/message', usage: { inputTokens: '4' } }
// @ts-expect-error An arbitrary object is not a folded panel document.
fitDocument({}, 65536)
fitDocument(foldRecords(parsed.records), 65536)
void [stopped, unsafeCount, badEvent]
