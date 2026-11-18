import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {readManuscript} from '../../lg-books/src/manuscript.js'
import {checkManuscript} from '../src/checks.js'
import * as plugin from '../index.js'

function setup(text='林澈平静如水。她离开了。') {
  const path=mkdtempSync(join(tmpdir(),'lg-checks-')),fixture=createBook(path)
  fixture.db.prepare('UPDATE document_versions SET content=? WHERE id=8').run(text)
  fixture.db.close()
  const books={manuscript:readManuscript},body=books.manuscript(path,1,8),target={document:1,version:8,token:body.token}
  return {path,books,target,check:rules=>checkManuscript(books,path,target,rules)}
}
test('checks expose missed literal and length constraints on selected candidate without modifying any book bytes',()=>{
  const s=setup(),file=join(s.path,'.literarygiant/story.sqlite3'),before=readFileSync(file)
  const result=s.check({minHan:220,maxHan:350,required:['离开'],forbidden:['平静如水'],ending:'她离开了。'})
  assert.equal(result.passed,false);assert.equal(result.target.version,8)
  assert.deepEqual(result.checks.map(c=>c.passed),[false,true,false,true])
  assert.deepEqual(result.checks[2].positions,[{start:2,end:6}])
  assert.equal(result.metrics.han,10);assert.deepEqual(readFileSync(file),before)
  assert.equal(s.books.manuscript(s.path,1).selected.content,'林澈关上灯。海风停了。')
})
test('empty chapter statistics and no configured rules do not masquerade as quality approval',()=>{
  const s=setup(),body=s.books.manuscript(s.path,3)
  const result=checkManuscript(s.books,s.path,{document:3,version:body.selected.id,token:body.token},{})
  assert.equal(result.passed,null);assert.deepEqual(result.metrics,{han:0,characters:0,paragraphs:0})
  assert.equal(checkManuscript(s.books,s.path,{document:3,version:3,token:body.token},{minHan:1}).passed,false)
})
test('Unicode statistics use code points; literal evidence uses valid UTF-16 ranges and preserves exact whitespace',()=>{
  const s=setup('𠮷😀甲甲甲\r\nABC 12。\n'),result=s.check({required:['😀','甲甲'],forbidden:['abc'],ending:'。'})
  assert.deepEqual(result.metrics,{han:4,characters:15,paragraphs:2})
  assert.deepEqual(result.checks[0].positions,[{start:2,end:4}])
  assert.equal(result.checks[1].count,2)
  assert.equal(result.checks[2].passed,true);assert.equal(result.checks[3].passed,false)
  assert.equal(s.check({ending:'。\n'}).passed,true)
})
test('invalid and excessive rules fail before checking; repeated hits remain bounded',()=>{
  const s=setup('甲'.repeat(1000))
  for(const rules of [null,[],{minHan:-1},{maxHan:0.5},{minHan:10,maxHan:2},{unknown:1},{forbidden:['']},{required:['x','x']},{required:['x'],forbidden:['x']},{ending:' '},{forbidden:['\ud800']},{forbidden:Array(33).fill('x')},{required:['x'.repeat(101)]}]) assert.throws(()=>s.check(rules))
  const result=s.check({forbidden:['甲']}).checks[0]
  assert.equal(result.count,1000);assert.equal(result.positions.length,20);assert.equal(result.truncated,true)
})
test('wrong document/version pairing and stale chapter snapshot fail rather than checking another text',()=>{
  const s=setup()
  assert.throws(()=>checkManuscript(s.books,s.path,{...s.target,version:6},{}),/版本不存在/)
  assert.throws(()=>checkManuscript(s.books,s.path,{...s.target,document:6,version:6},{}),/章节或场景/)
  assert.throws(()=>checkManuscript(s.books,s.path,{...s.target,version:undefined},{}),/请选择/)
  assert.throws(()=>checkManuscript(s.books,s.path,{...s.target,token:'stale'},{}),/已变化/)
})
test('real Cordis review service exposes checks through optional HTTP and disposes the route',async()=>{
  const s=setup(),ctx=new Context(),routes=new Map()
  const deps=ctx.plugin(c=>{c.provide('literaryBooks',s.books);c.provide('literaryPlanning',{});c.provide('literaryContext',{})});await deps.await()
  const fiber=ctx.plugin(plugin);await fiber.await()
  assert.equal(ctx.get('literaryReview').check(s.path,s.target,{forbidden:['平静如水']}).passed,false)
  const connection=ctx.plugin(c=>c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}}}));await connection.await()
  try {
    const call=target=>routes.get('/api/lg/review').fetch(new Request('http://localhost/api/lg/review',{method:'POST',body:JSON.stringify({action:'check',path:s.path,target,rules:{forbidden:['平静如水']}})}))
    const response=await call(s.target);assert.equal(response.status,200);assert.equal((await response.json()).value.passed,false)
    assert.equal((await call({...s.target,token:'stale'})).status,400)
  } finally {await connection.dispose();assert.equal(routes.size,0);await fiber.dispose();await deps.dispose()}
})
