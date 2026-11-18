import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as author from '../index.js'

test('profile-scoped author API persists across Cordis reload and unregisters cleanly',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lg-author-host-')),ctx=new Context(),routes=new Map()
  const deps=ctx.plugin(c=>{
    c.provide('literaryBooks',{readState(){throw new Error('未登记作品')}});c.provide('profileContext',{dir})
    c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}})
  });await deps.await();let plugin=ctx.plugin(author,{legacyPersonalPath:join(dir,'absent.json')});await plugin.await()
  const api=async input=>(await routes.get('/api/lg/author').fetch(new Request('http://localhost/api/lg/author',{method:'POST',body:JSON.stringify(input)}))).json()
  try{
    const change={scope:'personal',values:{name:'星桥',detail:'concise',writing:'短句'}}
    const p=await api({action:'preview',change});assert.equal(p.ok,true)
    const saved=await api({action:'apply',change,token:p.value.token,operation:randomUUID()});assert.equal(saved.ok,true)
    await plugin.dispose();assert.equal(routes.size,0);assert.equal(ctx.get('literaryAuthor'),undefined)
    plugin=ctx.plugin(author,{legacyPersonalPath:join(dir,'absent.json')});await plugin.await()
    assert.equal((await api({action:'read'})).value.effective.name,'星桥')
    assert.equal((await api({action:'read',path:'unregistered'})).ok,false)
    assert.equal((await api({action:'generate'})).ok,false)
  }finally{await plugin.dispose();await deps.dispose()}
  assert.equal(routes.size,0)
})
