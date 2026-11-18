import test from 'node:test'
import assert from 'node:assert/strict'
import {agentCatalog} from '../lg-dashboard/src/team-data.js'
test('legacy member-only catalog still lists coordinator first without fabricating a prompt',()=>{
 const members=['analysis','planning','writing'].map(id=>({id}))
 const list=agentCatalog(members)
 assert.deepEqual(list.map(r=>r.id),['coordinator','analysis','planning','writing'])
 assert.equal(list[0].prompt,null)
 assert.equal(members.length,3)
})
test('current catalog preserves actual coordinator prompt, places it first, and deduplicates it',()=>{
 const main={id:'coordinator',prompt:'Actual prompt',version:'1.1.0'}
 const list=agentCatalog([{id:'analysis'},main,{id:'planning'},main,{id:'writing'}])
 assert.equal(list[0],main)
 assert.deepEqual(list.map(r=>r.id),['coordinator','analysis','planning','writing'])
})
