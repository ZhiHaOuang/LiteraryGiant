import {test} from 'node:test'
import assert from 'node:assert/strict'
import {apply} from '../index.js'
function route(llm) {
 let handler
 apply({get:()=>llm,inject:(keys,fn)=>fn({effect:fn=>fn(),connection:{fetch:{register(value){handler=value.fetch;return()=>{}}}}})})
 return handler
}
test('provider directory only exposes id/name and does not probe model endpoints',async()=>{
 const fetch=route({listProviders:()=>[{id:'local-vllm',name:'Local model',credential:'never-return',baseURL:'private-endpoint'}],listModels(){throw Error('must not probe')}})
 const response=await fetch()
 assert.deepEqual(await response.json(),{ok:true,providers:[{id:'local-vllm',name:'Local model'}]})
 assert.equal(response.headers.get('cache-control'),'no-store')
})
test('unavailable provider directory is distinguished from an empty configured directory',async()=>{
 assert.deepEqual(await (await route(null)()).json(),{ok:false,providers:[]})
 assert.deepEqual(await (await route({listProviders:()=>[]})()).json(),{ok:true,providers:[]})
})
