import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBook } from '../../lg-books/tests/fixture.mjs'
import { readManuscript } from '../../lg-books/src/manuscript.js'
import { writeManuscript } from '../../lg-books/src/write.js'
import { Executor } from '../../lg-execution/src/run.js'
import { createAgents } from '../../lg-agents/src/service.js'
import { planningRequestHash } from '../../lg-agents/src/planning.js'
import { referenceRequestHash } from '../../lg-agents/src/library.js'
import { memoryRequestHash } from '../../lg-agents/src/memory.js'
import { reviewRequestHash } from '../../lg-agents/src/review.js'
import { listMethods, selectMethod } from '../methods.js'

function setup() {
  const path = mkdtempSync(join(tmpdir(),'lg-method-'))
  createBook(path).db.close()
  const snapshot = readManuscript(path,1)
  const books = {manuscript:readManuscript,candidate:(p,i,g)=>writeManuscript(p,{...i,action:'candidate'},g)}
  const meter = new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxOutputTokens:200,maxInputBytes:16000})
  const calls = []
  const execution = {preview:i=>meter.preview(i),run:async(id,input)=>{
    calls.push(input)
    return {id,status:'succeeded',result:{text:'<lg-replacement>\n林澈说：“熄灯。”\n</lg-replacement>'}}
  }}
  let registry = {list:listMethods,select:selectMethod}
  const make = enabled => createAgents(books,execution,{roles:[]},undefined,undefined,undefined,undefined,undefined,undefined,enabled)
  const input = {task:'polish',path,document:1,version:snapshot.selected.id,token:snapshot.token,start:0,end:6,request:'精简动作。',operation:randomUUID()}
  return {agents:make(()=>registry),plain:make(),input,calls,meter,disable:()=>{registry=null}}
}
test('installing optional methods does not change unselected input, price or signature',()=>{
  const s=setup()
  assert.deepEqual(s.agents.preview(s.input),s.plain.preview(s.input))
  assert.ok(s.agents.methods('polish').some(m=>m.name==='lg-manuscript-editor'))
  assert.deepEqual(s.plain.methods('polish'),[])
})
test('selected technique is metered and signed exactly as delivered; candidate retains its source and technique',async()=>{
  const s=setup(),input={...s.input,method:'lg-style-controller'}
  const plain=s.agents.preview(s.input), plan=s.agents.preview(input)
  assert.notEqual(plan.signature,plain.signature)
  assert.equal(plan.outputFormat,'replacement-block-v1')
  assert.equal(plain.outputFormat,'json')
  assert.equal(plan.inputBytes,Buffer.byteLength(plan.modelInput.system+plan.modelInput.input))
  assert.equal(plan.reservedCny,s.meter.preview(plan.modelInput).micros/1e6)
  assert.ok(plan.modelInput.system.includes(plan.method.technique))
  assert.ok(!plan.modelInput.system.includes('literary_propose_task'))
  const result=await s.agents.run({...input,signature:plan.signature})
  assert.equal(result.status,'candidate-ready');assert.deepEqual(s.calls,[plan.modelInput])
  const manuscript=readManuscript(input.path,1,result.candidate.version)
  assert.equal(manuscript.selected.content,'林澈说：“熄灯。”海风停了。')
  assert.deepEqual(manuscript.selected.metadata.generation.method,plan.method)
  assert.equal(manuscript.document.activeVersion,input.version)
})
test('unknown, incompatible, removed or swapped methods fail before the model call',async()=>{
  const s=setup(),input={...s.input,method:'lg-style-controller'},plan=s.agents.preview(input)
  for(const method of ['lg-reference-abstractor','../../foreign',{},null])assert.throws(()=>s.agents.preview({...input,method}))
  await assert.rejects(s.agents.run({...input,method:'lg-manuscript-editor',signature:plan.signature}),/变化/)
  s.disable()
  await assert.rejects(s.agents.run({...input,signature:plan.signature}),/lg-skills/)
  assert.equal(s.calls.length,0)
})
test('cached planning, memory, reference and review requests bind the chosen method and preserve old hashes when omitted',()=>{
  const input={task:'fixture',path:'book',request:'检查',target:{id:1}}
  for(const hash of [planningRequestHash,memoryRequestHash,referenceRequestHash,reviewRequestHash]){
    assert.equal(hash(input),hash({...input,method:undefined}))
    assert.notEqual(hash({...input,method:'lg-failure-logger'}),hash({...input,method:'lg-continuity-checker'}))
  }
})
