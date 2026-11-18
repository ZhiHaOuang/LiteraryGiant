import {test} from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers/promises'
import {requestBooks,pollOverview} from '../src/api.js'

test('Books requests preserve mutation identity and signal without retrying failures',async t=>{
  const input={action:'create',operation:'author-operation',path:'/synthetic/new-book'}
  const controller=new AbortController(),calls=[]
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,options})
    return Response.json({ok:false,error:'creation result unknown'},{status:400})
  })
  await assert.rejects(requestBooks(input,controller.signal),/creation result unknown/)
  assert.equal(calls.length,1)
  assert.equal(calls[0].options.signal,controller.signal)
  assert.deepEqual(JSON.parse(calls[0].options.body),input)
})

test('Books requests surface HTTP failures and return only successful values',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({ok:true,value:{books:[]}}))
  assert.deepEqual(await requestBooks({action:'shelf'}),{books:[]})
  globalThis.fetch=async()=>Response.json({ok:true,value:[]},{status:503})
  await assert.rejects(requestBooks({action:'shelf'}),/请求失败/)
})

test('slow statistics reads are shared with refresh; next poll starts after completion',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let resolve,calls=0
  const values=[],poll=pollOverview(()=>{calls++;return new Promise(done=>{resolve=done})},v=>values.push(v),assert.fail)
  const first=poll.refresh();await setImmediate()
  t.mock.timers.tick(90000)
  assert.equal(poll.refresh(),first)
  assert.equal(calls,1)
  resolve('current');await first
  assert.deepEqual(values,['current'])
  t.mock.timers.tick(29999);await setImmediate();assert.equal(calls,1)
  t.mock.timers.tick(1);await setImmediate();assert.equal(calls,2)
  poll.dispose();resolve('after unmount');await setImmediate()
  t.mock.timers.tick(90000);await setImmediate()
  assert.deepEqual(values,['current']);assert.equal(calls,2)
})

test('statistics recover on refresh after failure and ignore failures after disposal',async()=>{
  let fail=true,reject
  const errors=[],values=[]
  const poll=pollOverview(()=>fail?Promise.reject(Error('offline')):Promise.resolve('recovered'),v=>values.push(v),e=>errors.push(e.message))
  await poll.refresh();fail=false;await poll.refresh();poll.dispose()
  assert.deepEqual(errors,['offline']);assert.deepEqual(values,['recovered'])
  const stopped=pollOverview(()=>new Promise((_,no)=>{reject=no}),assert.fail,assert.fail)
  const request=stopped.refresh();await setImmediate();stopped.dispose();reject(Error('late'));await request
})
