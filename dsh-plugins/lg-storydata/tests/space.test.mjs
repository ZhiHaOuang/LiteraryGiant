import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,linkSync,symlinkSync,realpathSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {createSpaceReader} from '../src/space-history.js'
import {sumParts} from '../src/space-categories.js'

test('registered file bytes, category totals, chapter checkpoints and independent plot boundaries',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'lg-space-')))
  const shelf=['a','b'].map((name,i)=>({id:name,name,path:join(root,name),archived:!!i}))
  for(const b of shelf)createBook(b.path).db.close()
  const books={list:opts=>{assert.equal(opts.includeArchived,true);return shelf},readState:(p,f)=>accessState(p,false,f)}
  const a=shelf[0].path,shared=join(a,'manuscript')
  mkdirSync(shared);writeFileSync(join(shared,'chapter.md'),'海abc') // 6 bytes in UTF-8
  linkSync(join(shared,'chapter.md'),join(shared,'another.md'))
  symlinkSync(root,join(a,'external'))
  mkdirSync(join(a,'.literarygiant/conversations'));writeFileSync(join(a,'.literarygiant/conversations/test'),'chat')
  accessState(a,true,db=>{
    db.exec("CREATE TABLE lg_outline_test (item TEXT); INSERT INTO lg_outline_test VALUES ('a');")
  })
  let plotCount=null
  const options={profile:join(root,'profile'),segments:()=>({count:()=>plotCount})}
  let reader=createSpaceReader(books,options)
  t.after(()=>reader.close())
  const first=await reader.read()
  assert.equal(first.historyStatus,'saved')
  assert.equal(first.bookCount,2);assert.equal(first.chapters,6);assert.equal(first.files,8)
  assert.equal(first.parts.manuscript,6);assert.equal(first.parts.chats,4)
  assert.equal(first.parts.main>0,true)
  const expected=shelf.flatMap(b=>['.literarygiant/story.sqlite3','.literarygiant/project.json','ReferenceLibrary/bible/book-overview.json'].map(p=>statSync(join(b.path,p)).size))
  assert.equal(sumParts(first.parts),expected.reduce((a,b)=>a+b,10))
  assert.equal(first.plotAvailable,false);assert.deepEqual(first.history.plot,[])
  assert.deepEqual(first.history.chapter[0].previous,first.parts)
  const [again,other]=await Promise.all([reader.read(),reader.read()])
  assert.deepEqual(again,other);assert.deepEqual(first,again)

  writeFileSync(join(shared,'chapter.md'),'x')
  plotCount=1
  const second=await reader.read()
  assert.equal(second.history.chapter.length,1)
  assert.equal(second.history.chapter[0].parts.manuscript-second.history.chapter[0].previous.manuscript,-5)
  assert.equal(second.history.plot[0].position,2)
  accessState(a,true,db=>db.exec("UPDATE documents SET state='archived' WHERE id=5"))
  const changed=await reader.read()
  assert.deepEqual(changed.history.chapter.map(p=>p.position),[6,5])
  assert.deepEqual(changed.history.chapter[1].previous,second.parts)
  assert.equal(changed.history.plot.length,1)
  plotCount=2
  assert.deepEqual((await reader.read()).history.plot.map(p=>p.position),[2,4])
  reader.close();reader=createSpaceReader(books,options)
  assert.deepEqual((await reader.read()).history.chapter,changed.history.chapter)
  shelf.push({id:'missing',name:'Missing',error:'Unavailable'})
  const partial=await reader.read()
  assert.deepEqual(partial.unavailable,['Missing'])
  assert.deepEqual(partial.history.chapter,[])
  shelf.pop();shelf.pop()
  assert.equal((await reader.read()).history.chapter.length,1,'changed shelf starts its own baseline')
})
