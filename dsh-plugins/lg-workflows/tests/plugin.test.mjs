import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as workflows from '../index.js'

test('Cordis author route and service disappear on disposal; unsupported author actions fail',async()=>{
  const ctx=new Context(),routes=new Map()
  const deps=ctx.plugin(c=>{
    c.provide('literaryBooks',{readState(path,fn){if(path!=='registered')throw new Error('未登记作品');return fn({prepare:()=>({get:()=>undefined})})}})
    c.provide('literaryAgents',{})
    c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}})
  });await deps.await()
  const plugin=ctx.plugin(workflows);await plugin.await()
  try{
    assert.equal(typeof ctx.get('literaryWorkflows').advance,'function')
    const route=routes.get('/api/lg/workflows'),api=async input=>(await route.fetch(new Request('http://localhost/api/lg/workflows',{method:'POST',body:JSON.stringify(input)}))).json()
    assert.deepEqual((await api({action:'list',path:'registered'})).value.items,[])
    assert.equal((await api({action:'list',path:'unregistered'})).ok,false)
    assert.equal((await api({action:'adopt',path:'registered'})).ok,false)
  }finally{await plugin.dispose();await deps.dispose()}
  assert.equal(routes.size,0);assert.equal(ctx.get('literaryWorkflows'),undefined)
})
