import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'
import { createBook } from './fixture.mjs'

test('Cordis owns service and route lifetime; API rejects unregistered books and unknown actions', async () => {
  const root=mkdtempSync(join(tmpdir(),'lg-plugin-test-'));createBook(root).db.close()
  const ctx=new Context(), routes=new Map()
  const dependencies=ctx.plugin(c => {
    c.provide('connection',{fetch:{register(route) {
      routes.set(route.path,route); return () => routes.delete(route.path)
    }}})
    c.provide('configEditor',{edit() { throw new Error('Not expected') }})
  })
  await dependencies.await()
  const fiber=ctx.plugin(plugin,{projects:[root]});await fiber.await()
  const service=ctx.get('literaryBooks')
  assert.equal(service.list()[0].name,'潮汐来信 · 验证书稿')
  const call=body => routes.get('/api/lg/books').fetch(new Request('http://localhost/api/lg/books',{
    method:'POST',body:JSON.stringify(body)}))
  assert.equal((await (await call({action:'read',path:root})).json()).value.chapters.length,3)
  assert.equal((await call({action:'read',path:'/unregistered'})).status,400)
  assert.equal((await call({action:'write',path:root})).status,400)
  assert.equal((await call(null)).status,400)
  const story=await (await call({action:'story-data',path:root})).json()
  assert.equal(story.ok,true);assert.equal(Object.keys(story.value.catalog).length,14)
  assert.equal(story.value.total,0)
  assert.equal((await call({action:'story-data',path:'/unregistered'})).status,400)
  assert.equal((await call({action:'story-data-import',path:root})).status,400,'dashboard route stays read-only')
  const time=await (await call({action:'story-time',path:root})).json()
  assert.equal(time.ok,true);assert.deepEqual(time.value.events,[])
  assert.equal((await call({action:'story-time',path:'/unregistered'})).status,400)
  assert.equal((await call({action:'story-time',path:root,options:{include_candidates:'yes'}})).status,400)
  const documents=body=>routes.get('/api/lg/documents').fetch(new Request('http://localhost/api/lg/documents',{method:'POST',body:JSON.stringify(body)}))
  const change={action:'create',kind:'note',slug:'api-note',title:'接口笔记',content:'作者记录',reason:'验证接口'}
  const preview=(await (await documents({action:'preview',path:root,change})).json()).value
  const saved=await (await documents({action:'apply',path:root,change,token:preview.token,operation:randomUUID()})).json()
  assert.equal(saved.ok,true)
  assert.equal((await (await documents({action:'read',path:root,id:saved.value.id})).json()).value.current.content,'作者记录')
  assert.equal((await documents({action:'list',path:'/unregistered'})).status,400)
  assert.equal((await documents({action:'candidate',path:root})).status,400)
  assert.equal((await (await call({action:'integrity',path:root})).json()).value.ok,true)
  await fiber.dispose()
  assert.equal(ctx.get('literaryBooks'),undefined)
  assert.equal(routes.size,0)
  await dependencies.dispose()
})
