import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewTask, runTask, cancelTask } from '../src/client-task.js'

for (const fields of [
  { task:'extract-memory',target:{document:1,version:2,token:'chapter-snapshot',start:3,end:8} },
  { task:'analyze-reference',category:'EventsLibrary',references:['original-citation'] },
]) {
  test(fields.task+' uses the reviewed request and operation across execution, retry and cancellation',async()=>{
    const input={...fields,path:'/synthetic-book',request:'核对来源。',operation:'author-preview-operation'}
    const calls=[],plan={task:input.task,source:{units:[]},modelInput:{input:'model projection'},signature:'signed'}
    const request=(endpoint,payload,signal)=>{calls.push({endpoint,payload,signal});return plan}
    const preview=await previewTask(request,input)
    assert.deepEqual(preview,{input,plan})
    const signal=new AbortController().signal
    await runTask(request,preview,signal)
    await runTask(request,preview,signal)
    await cancelTask(request,preview)
    assert.deepEqual(calls,[
      {endpoint:'agents',payload:{...input,action:'preview'},signal:undefined},
      ...Array.from({length:2},()=>({endpoint:'agents',payload:{...input,action:'run',signature:plan.signature},signal})),
      {endpoint:'agents',payload:{action:'cancel',path:input.path,operation:input.operation},signal:undefined}
    ])
  })
}
