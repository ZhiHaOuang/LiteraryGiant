import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initializeBook, previewCreation } from '../src/initialize.js'
import { readBook, openBook } from '../src/read.js'
import { ensurePolicy } from '../src/supervision-policy.js'
import { digest,readManuscript } from '../src/manuscript.js'
import { previewAcceptance,writeManuscript } from '../src/write.js'
import { createBook } from './fixture.mjs'

const all=['CharacterArc','EventsLibrary','PayoffAngst','EmotionRhythm','Worldview']
const parent=()=>realpathSync(mkdtempSync(join(tmpdir(),'lg-policy-')))

test('new-book preview and retry use the legacy five-category policy without resetting author changes',()=>{
  const path=join(parent(),'book'), preview=previewCreation(path,'新书'), input={...preview,operation:randomUUID()}
  assert.ok(preview.creates.includes('.literarygiant/supervision.json'))
  const book=initializeBook(input), file=join(path,'.literarygiant/supervision.json')
  const policy=JSON.parse(readFileSync(file,'utf8'))
  assert.deepEqual(policy,{schema:'lg.supervision.v1',project_id:book.id,chapter_categories:all,volume_categories:all})
  policy.chapter_categories=['EventsLibrary']
  writeFileSync(file,JSON.stringify(policy))
  initializeBook(input)
  assert.deepEqual(readBook(path).supervision.categories,['EventsLibrary'])
})

test('books predating supervision are read without mutation; enabling twice preserves the original file',()=>{
  const path=parent();createBook(path).db.close()
  const file=join(path,'.literarygiant/supervision.json')
  assert.deepEqual(readBook(path).supervision,{categories:[]});assert.equal(existsSync(file),false)
  const book=openBook(path,{write:true})
  try {
    assert.deepEqual(ensurePolicy(book).chapter_categories,all)
    const inode=statSync(file).ino
    assert.deepEqual(ensurePolicy(book).chapter_categories,all);assert.equal(statSync(file).ino,inode)
    for(const raw of ['broken',JSON.stringify({...ensurePolicy(book),project_id:'other'})]){
      writeFileSync(file,raw)
      assert.throws(()=>ensurePolicy(book));assert.equal(readFileSync(file,'utf8'),raw)
      assert.ok(readBook(path).supervision.error)
    }
  } finally {book.close()}
})

test('an interrupted old creation resumes its original preview and a new book requires the new preview',()=>{
  const dir=parent(),path=join(dir,'old'),name='旧创建',operation=randomUUID()
  const {dev,ino}=statSync(dir),value={path,name,parent:{dev,ino}},token=digest(value)
  assert.throws(()=>initializeBook({path,name,operation,token}),/重新预览/)
  mkdirSync(join(path,'.literarygiant'),{recursive:true})
  const stat=statSync(path), project={schema_version:'lg.story-project.v1',project_id:'old-test',name,workspace:path,created_at:'2026',updated_at:'2026'}
  writeFileSync(join(path,'.literarygiant/creation.json'),JSON.stringify({schema:'lg.creation.v1',signature:digest({...value,operation}),directory:{dev:stat.dev,ino:stat.ino},project}))
  initializeBook({path,name,operation,token})
  assert.deepEqual(readBook(path).supervision,{categories:[]})
})

test('enabling supervision invalidates an open unsupervised adoption even with a matching chapter token',()=>{
  const path=parent();createBook(path).db.close()
  const token=readManuscript(path,1).token
  const saved=writeManuscript(path,{action:'candidate',document:1,token,operation:randomUUID(),content:'灯火熄灭。',reason:'比较候选'})
  const input={action:'accept',document:1,version:saved.version,token,operation:randomUUID()}
  const preview=previewAcceptance(path,input)
  assert.equal(preview.supervision,null)
  const book=openBook(path,{write:true})
  try {ensurePolicy(book)} finally {book.close()}
  assert.throws(()=>writeManuscript(path,{...input,reviewToken:preview.reviewToken}),/候选审阅缺失/)
  assert.equal(readManuscript(path,1).document.activeVersion,1)
})
