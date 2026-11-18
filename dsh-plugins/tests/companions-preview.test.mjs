import test from 'node:test'
import assert from 'node:assert/strict'
import {previewUsageDays,sparkDays} from '../lg-dashboard/src/roster-data.js'
import {dateKeys} from '../lg-dashboard/src/global-data.js'

test('preview data is deterministic, varies by role and day, and stays inside the selected dates',()=>{
 const keys=dateKeys('2026-11-01','2026-11-12')
 const lead=previewUsageDays(keys,'coordinator'),writing=previewUsageDays(keys,'writing')
 assert.equal(Object.keys(lead).length,12)
 assert.deepEqual(lead,previewUsageDays(keys,'coordinator'))
 assert.notDeepEqual(lead,writing)
 assert.ok(new Set(Object.values(lead).map(d=>d.tokens)).size>5)
 assert.ok(Object.values(lead).every(d=>d.requests>0&&d.known===d.requests&&d.tokens>0))
 assert.equal(sparkDays(lead,keys,112).length,7)
 assert.deepEqual(previewUsageDays([],'coordinator'),{})
})
