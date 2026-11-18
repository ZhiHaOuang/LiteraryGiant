import test from 'node:test'
import assert from 'node:assert/strict'
import {monitorOf,usageBars} from '../lg-dashboard/src/team-data.js'

const order=['coordinator','analysis','planning','writing']
const partValues=bar=>Object.fromEntries(bar.parts.map(part=>[part.key,part.value]))
const partTotal=bar=>bar.parts.reduce((sum,part)=>sum+part.value,0)
const roleRow=(role,patch={})=>({role,requests:0,input:0,output:0,known:0,cache:0,failed:0,pending:0,elapsedMs:0,timed:0,measured:0,inputChars:{},outputChars:{},stages:{},...patch})

test('legacy role totals render four Agent bars without request series and do not add cache twice',()=>{
 const monitor=monitorOf({roles:[
  {role:'coordinator',requests:2,inputTokens:120,outputTokens:30,knownUsage:2,failed:0,pending:0},
  {role:'analysis',requests:1,inputTokens:50,outputTokens:10,knownUsage:1,failed:0,pending:0},
  {role:'planning',requests:0,inputTokens:0,outputTokens:0,knownUsage:0,failed:0,pending:0},
  {role:'writing',requests:1,inputTokens:80,outputTokens:70,knownUsage:1,failed:0,pending:0},
 ]})
 assert.equal(monitor.series.length,0)
 // Legacy inputTokens already includes the provider's cached input.
 monitor.roles[0].cache=90
 const bars=usageBars(monitor.roles,'tokens')
 assert.deepEqual(bars.map(bar=>bar.role),order)
 assert.deepEqual(bars.map(bar=>bar.value),[150,60,0,150])
 assert.equal(partValues(bars[0]).input,120)
 assert.equal(partValues(bars[0]).output,30)
 assert.equal(partTotal(bars[0]),150)
 assert.equal(bars[0].missing,0)
})

test('input and output composition use recorded character totals, never apportion billed tokens',()=>{
 const rows=[roleRow('analysis',{requests:1,known:1,measured:1,input:12000,output:500,
  inputChars:{system:30,schemas:60,user:10},outputChars:{text:50,reasoning:20,toolarg:30}})]
 const input=usageBars(rows,'input')[1],output=usageBars(rows,'output')[1]
 assert.equal(input.value,100)
 assert.equal(partValues(input).system,30)
 assert.equal(partValues(input).schemas,60)
 assert.equal(partValues(input).user,10)
 assert.equal(partTotal(input),100)
 assert.equal(output.value,100)
 assert.equal(partValues(output).text,50)
 assert.equal(partValues(output).reasoning,20)
 assert.equal(partValues(output).toolarg,30)
 assert.equal(usageBars(rows,'tokens')[1].value,12500)
})

test('missing measurements differ from zero-use Agents and partial coverage is explicit',()=>{
 const rows=[roleRow('coordinator',{requests:2}),roleRow('analysis',{requests:3,known:1,input:80,output:20})]
 for(const mode of ['tokens','input','output','time']){
  const bars=usageBars(rows,mode)
  assert.equal(bars[0].value,null,mode+' should preserve unknown measurements')
  assert.equal(bars[0].missing,2,mode+' should count unmeasured requests')
  assert.equal(bars[2].value,0,mode+' should preserve actual zero activity')
  assert.equal(bars[2].missing,0)
 }
 assert.equal(usageBars(rows,'requests')[0].value,2)
 const partial=usageBars(rows,'tokens')[1]
 assert.equal(partial.value,100)
 assert.equal(partial.missing,2)
 assert.equal(partTotal(partial),100)
})

test('Agent totals include the entire selected range rather than a capped request series',()=>{
 const monitor=monitorOf({monitoring:{version:1,
  roles:[roleRow('writing',{requests:420,known:420,input:800000,output:190000})],
  series:Array.from({length:300},(_,i)=>({id:String(i),role:'writing',input:1,output:1})),omitted:120,
 }})
 assert.equal(usageBars(monitor.roles,'tokens')[3].value,990000)
 assert.equal(usageBars(monitor.roles,'requests')[3].value,420)
})

test('elapsed-time stacks retain unsegmented history and every mode preserves stable role order without mutations',()=>{
 const rows=[roleRow('writing',{requests:1,timed:1,measured:1,elapsedMs:1000,stages:{ttft:100,text:300}}),roleRow('coordinator')]
 const before=JSON.stringify(rows)
 for(const mode of ['tokens','input','output','requests','time'])assert.deepEqual(usageBars(rows,mode).map(bar=>bar.role),order)
 const time=usageBars(rows,'time')[3]
 assert.equal(time.value,1000)
 assert.equal(partValues(time).ttft,100)
 assert.equal(partValues(time).text,300)
 assert.equal(partValues(time).unsegmented,600)
 assert.equal(partTotal(time),1000)
 assert.equal(JSON.stringify(rows),before)
})

test('Context stacks use captured estimates with distinct skill injection and explicit historical gaps',()=>{
 const bars=usageBars([
  roleRow('coordinator',{requests:2,known:2,input:10000,output:500,contextMeasured:1,contextTokens:{system:25,schemas:100,user:5,developer:10,skill:20,assistant:30,tool:10}}),
  roleRow('analysis',{requests:1,known:1,input:800,output:20}),
 ],'context')
 assert.equal(bars[0].value,200);assert.equal(bars[0].missing,1)
 assert.equal(partValues(bars[0]).skill,20);assert.equal(partValues(bars[0]).schemas,100)
 assert.equal(bars[1].value,null);assert.equal(bars[1].missing,1)
 assert.equal(bars[2].value,0);assert.equal(bars[2].missing,0)
})

test('paired actual token columns keep partial and legacy composition unknown instead of fabricating it',async()=>{
 const {pairedTokenBars,usageModes,totalRoles}=await import('../lg-dashboard/src/team-data.js')
 const rows=[
  roleRow('coordinator',{requests:3,known:2,input:500,output:100,inputAllocation:{system:180,schemas:120,unknown:200},outputAllocation:{text:30,reasoning:20,unknown:50},inputCompositionKnown:1,outputCompositionKnown:1}),
  roleRow('analysis',{requests:1,known:1,input:400,output:30}),
  roleRow('writing',{requests:1,known:0}),
 ]
 const pairs=pairedTokenBars(rows),values=parts=>Object.fromEntries(parts.map(part=>[part.key,part.value]))
 assert.deepEqual(pairs.map(p=>p.role),order)
 assert.equal(pairs[0].input.value,500);assert.equal(pairs[0].output.value,100)
 assert.equal(values(pairs[0].input.parts).system,180);assert.equal(values(pairs[0].input.parts).unknown,200)
 assert.equal(values(pairs[0].output.parts).text,30);assert.equal(values(pairs[0].output.parts).unknown,50)
 assert.equal(pairs[0].missing,1);assert.equal(pairs[0].input.measured,1)
 assert.equal(values(pairs[1].input.parts).unknown,400);assert.equal(values(pairs[1].output.parts).unknown,30)
 assert.equal(pairs[2].input.value,0);assert.equal(pairs[3].input.value,null);assert.equal(pairs[3].output.value,null)
 const total=pairedTokenBars([{...totalRoles(rows),role:'coordinator'}])[0]
 assert.equal(total.input.value,900);assert.equal(values(total.input.parts).unknown,600)
 assert.equal(total.output.value,130);assert.equal(values(total.output.parts).unknown,80)
 assert.ok(!Object.hasOwn(usageModes,'input'));assert.ok(!Object.hasOwn(usageModes,'output'))
})

test('rounding noise does not invent an uncollected token segment',async()=>{
 const {pairedTokenBars}=await import('../lg-dashboard/src/team-data.js')
 const row=roleRow('analysis',{requests:1,known:1,input:1,output:0,inputAllocation:{system:1-Number.EPSILON}})
 const input=pairedTokenBars([row])[1].input
 assert.equal(input.parts.find(part=>part.key==='unknown').value,0)
})
