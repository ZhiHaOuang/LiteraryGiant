import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {runOutlineCase} from './outline-host.mjs'

for (const decision of ['approved','rejected']) test('two real analysis sessions bind one Main proposal: '+decision,async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'lg-outline-team-'))),path=join(root,'book')
  createBook(path).db.close()
  const result=await runOutlineCase({path,state:join(root,'team'),ids:['lin','lamp'],brief:'关灯后更新人物和情节。',attemptForbidden:true,
    propose(input,priors){
      assert.ok(input.source.chapters[0].paragraphs[0].text.includes('林澈关上灯'))
      assert.deepEqual(priors.map(p=>p.revision),[0,0])
      const basic={basis:'text',evidence:[{chapter:1,paragraph:1,quote:'林澈关上灯'}]}
      return {beat:'关灯',changes:[{...basic,id:'lin',title:'林澈',section:'people',text:'他关上了灯。',links:['lamp']},
        {...basic,id:'lamp',title:'熄灯',section:'plot',text:'码头的灯熄灭。',links:[]}]}
    },review(input){assert.equal(input.outline_diff.changes.length,2);return {decision,reason:'已核对动作和情节位置。'}}})
  assert.ok(result.errors.some(e=>e.name==='lg_outline_propose'))
  assert.equal(result.main.total,decision==='approved'?2:0)
  if(decision==='approved') assert.equal(result.main.items.find(i=>i.id==='lin').related[0].id,'lamp')
  else assert.ok(result.errors.some(e=>e.name==='lg_team_outline_commit'))
})


test('two character modules of one dossier are read and independently reviewed in the native tool loop',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'lg-character-team-'))),path=join(root,'book')
  createBook(path).db.close()
  const ids=['core@1.identity','core@1.situation'].map(module=>({id:'lin',module}))
  const result=await runOutlineCase({path,state:join(root,'team'),ids,brief:'审查并更新林澈的两个模块。',
    propose(input,priors){
      assert.equal(input.character_protocol.groups.length,8)
      assert.deepEqual(priors.map(p=>p.revision),[0,0])
      return {beat:'关灯',changes:ids.map(({id,module},i)=>({id,module,section:'people',title:'林澈',text:i?'现场关灯。':'名为林澈。',
        basis:'text',links:[],evidence:[{chapter:1,paragraph:1,quote:'林澈关上灯'}],entries:[{
          key:i?'light':'name',facet:i?'resources':'name',value:i?'触及现场的灯。':'林澈',tags:[],nature:'observation',scope:'当场',sources:[1]
        }]}))}
    },review(input){
      assert.equal(input.outline_diff.changes[1].after.entries[0].facet,'resources')
      return {decision:'approved',reason:'测试来源与两个模块对应。'}
    }})
  assert.equal(result.diff.status,'committed')
  assert.deepEqual(result.main.items.map(i=>i.module),ids.map(k=>k.module))
})
