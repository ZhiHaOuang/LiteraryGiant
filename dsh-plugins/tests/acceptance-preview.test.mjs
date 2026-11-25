import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewAcceptance } from '../lg-review/src/api.js'

test('author previews retain the candidate identity and fail closed without a review receipt',async t=>{
  const candidate={path:'/test/book',document:2,version:9,token:'chapter',action:'accept',operation:'preview-operation'}
  let value={supervision:null,reviewToken:'first-preview'}
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'api/lg/books')
    assert.deepEqual(JSON.parse(init.body),{...candidate,action:'acceptance-review'})
    return Response.json({ok:true,value})
  })
  assert.deepEqual(await reviewAcceptance(candidate),value)
  value={supervision:{reports:[]}}
  await assert.rejects(reviewAcceptance(candidate),/未收到采用预览/)
  assert.equal(candidate.action,'accept')
})
