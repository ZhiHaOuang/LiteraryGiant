import test from 'node:test'
import assert from 'node:assert/strict'
import {pairedTokenBars} from '../src/team-data.js'
import {agentStacks,INPUT_HEIGHT,OUTPUT_HEIGHT,BASE_LIFT} from '../src/components/agent-stacks.js'
const roles=['coordinator','analysis','planning','writing']
test('actual input/output stacks preserve all totals, composition and the unknown remainder',()=>{
 const pairs=pairedTokenBars([{role:'coordinator',requests:3,known:2,input:500,output:100,inputAllocation:{system:180,schemas:120},outputAllocation:{text:30,reasoning:20}}])
 const before=JSON.stringify(pairs),{columns}=agentStacks(pairs,320)
 assert.deepEqual(columns.map(c=>c.id),roles.flatMap(r=>[r+':input',r+':output']))
 assert.equal(columns[0].value,500);assert.equal(columns[1].value,100)
 assert.deepEqual(columns[0].parts.map(p=>[p.key,p.value]),[['system',180],['schemas',120],['unknown',200]])
 assert.deepEqual(columns[1].parts.map(p=>[p.key,p.value]),[['text',30],['reasoning',20],['unknown',50]])
 assert.equal(columns[0].missing,1)
 for(const c of columns)assert.equal(c.parts.reduce((s,p)=>s+p.value,0),c.value)
 assert.equal(JSON.stringify(pairs),before)
})
test('paired sides share x/width, fit their baseline half at all supported sizes, and keep separate scales',()=>{
 const pairs=pairedTokenBars(roles.map((role,i)=>({role,requests:1,known:1,input:10000*(i+1),output:10*(i+1),inputAllocation:{system:5000*(i+1),schemas:5000*(i+1)},outputAllocation:{text:5*(i+1),reasoning:5*(i+1)}})))
 for(const width of [220,300,600]){
  const {columns,maxima}=agentStacks(pairs,width)
  assert.equal(maxima.input,40000);assert.equal(maxima.output,40)
  for(let i=0;i<8;i+=2){assert.equal(columns[i].left,columns[i+1].left);assert.equal(columns[i].width,columns[i+1].width)}
  for(const c of columns){assert.ok(c.left>=0&&c.left+c.width<=width);assert.ok(c.height+BASE_LIFT<=(c.side==='input'?INPUT_HEIGHT:OUTPUT_HEIGHT));assert.ok(c.parts.every(p=>p.height>0&&Number.isFinite(p.height)))}
  assert.equal(columns[6].parts[0].height,columns[0].parts[0].height*4)
 }
})
test('rendered columns share bucket centers in both paired and single-sided layouts',()=>{
 const pairs=pairedTokenBars([])
 for(const [width,expectedWidth] of [[24,1],[40,4],[160,148/21]]){
  const paired=agentStacks(pairs,width),single=agentStacks(pairs,width,false)
  assert.equal(paired.barWidth,expectedWidth)
  assert.deepEqual(single.columns,paired.columns.filter(c=>c.side==='input'))
  for(const [i,column] of single.columns.entries()){
   const left=(i+.5)*width/pairs.length-expectedWidth/2
   assert.ok(Math.abs(column.left-left)<1e-12)
   assert.equal(column.width,expectedWidth)
   assert.equal(paired.columns[2*i+1].left,column.left)
  }
 }
})
test('missing usage stays unknown, zero stays zero, and smaller filtered totals recalculate without invented segments',()=>{
 const pairs=pairedTokenBars([{role:'coordinator',requests:1,known:0}])
 const {columns,maxima}=agentStacks(pairs,260)
 assert.equal(columns[0].value,null);assert.equal(columns[1].value,null)
 assert.equal(columns[2].value,0);assert.ok(columns.every(c=>c.parts.length===0&&c.height===0))
 assert.deepEqual(maxima,{input:0,output:0})
 const refreshed=agentStacks(pairedTokenBars([{role:'coordinator',requests:1,known:1,input:40,output:2}]),260)
 assert.equal(refreshed.columns[0].parts[0].key,'unknown');assert.equal(refreshed.columns[0].parts[0].value,40)
 assert.equal(refreshed.columns[1].value,2)
})
