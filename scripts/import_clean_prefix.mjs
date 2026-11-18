import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
const [modules,input,target]=process.argv.slice(2).map(p=>resolve(p))
const load=p=>import(pathToFileURL(join(modules,p)))
const {previewCreation,initializeBook,integrity}=await load('lg-books/src/initialize.js')
const {accessState}=await load('lg-books/src/state.js')
const {readBook}=await load('lg-books/src/read.js')
const {readManuscript}=await load('lg-books/src/manuscript.js')
const {writeManuscript}=await load('lg-books/src/write.js')
const {queueStructureMirror}=await load('lg-books/src/mirror-queue.js')
const {retryChapterMirror,chapterFile}=await load('lg-books/src/chapter-files.js')
const {wordCount}=await load('lg-books/src/summary.js')
const {createPlanning}=await load('lg-planning/src/service.js')
const raw=readFileSync(input), data=JSON.parse(raw)
assert.equal(data.status,'cleaned-draft')
assert.equal(data.chapters.length,100)
assert.deepEqual(data.chapters.map(c=>c.chapter_no),Array.from({length:100},(_,i)=>i+1))
const fingerprint=createHash('sha256').update(raw).digest('hex')
const receiptPath=join(target,'.literarygiant','prefix-import.json')
if(!existsSync(target)) {
  const preview=previewCreation(target,'放开那个女巫 · 前100章续写实验')
  initializeBook({...preview,operation:randomUUID()})
  writeFileSync(receiptPath,JSON.stringify({fingerprint,source_sha256:data.source_sha256,scope:'source chapters 1–100 only',state:'importing'}),{flag:'wx'})
}
const receipt=JSON.parse(readFileSync(receiptPath))
assert.equal(receipt.fingerprint,fingerprint,'Different import already occupies this directory')
const books={readState:(p,f)=>accessState(p,false,f),changeState:(p,f)=>accessState(p,true,f),
 chapterMirrors:{queue:queueStructureMirror,finish:(p,r)=>retryChapterMirror(p,r.chapter,r.operation)}}
const planning=createPlanning(books)
for(const c of data.chapters){
 const slug=`chapter-${String(c.chapter_no).padStart(4,'0')}`
 const title=c.raw_title+(c.content.trim()?'':'【原文缺失】')
 let row=books.readState(target,db=>db.prepare('SELECT id FROM documents WHERE slug=?').get(slug))
 if(!row){
  const change={action:'structure.create',kind:'chapter',slug,title,sequence:c.chapter_no}
  const preview=planning.preview(target,change)
  row=planning.apply(target,change,preview.token,randomUUID())
 }
 const current=readManuscript(target,row.id)
 if(current.document.content!==c.content){
  assert.equal(current.document.content,'','Existing prose changed; refusing overwrite')
  const result=writeManuscript(target,{action:'edit',operation:randomUUID(),document:row.id,
    token:current.token,sourceVersion:current.document.activeVersion,content:c.content,
    reason:`作者授权的既有小说清洗草稿导入；原作第${c.chapter_no}章；来源SHA256 ${data.source_sha256}。用于续写实验，非模型创作。`})
  assert.equal(result.sync,'synchronized')
 }
}
assert.equal(integrity(target).ok,true)
const rows=books.readState(target,db=>db.prepare("SELECT d.id,d.title,d.sequence,d.state,v.content FROM documents d JOIN document_versions v ON v.id=d.active_version_id WHERE d.kind='chapter' ORDER BY d.sequence").all())
assert.equal(rows.length,100)
let words=0
rows.forEach((r,i)=>{const c=data.chapters[i];assert.equal(r.content,c.content);assert.equal(r.title,c.raw_title+(c.content.trim()?'':'【原文缺失】'));assert.equal(r.sequence,i+1);assert.equal(r.state,'draft');words+=wordCount(r.content)})
const dashboard=readBook(target)
assert.equal(dashboard.chapters.length,100)
assert.equal(dashboard.words,words)
assert.equal(dashboard.acceptedWords,0)
for(const row of rows) assert.equal(chapterFile(target,{action:'chapter-file-preview',document:row.id}).state,'clean')
writeFileSync(receiptPath,JSON.stringify({...receipt,state:'complete',chapters:100,words,missing_chapters:data.chapters.filter(c=>!c.content.trim()).map(c=>c.chapter_no),verified_at:new Date().toISOString()},null,2))
console.log(JSON.stringify({path:target,chapters:100,words,integrity:integrity(target),dashboard},null,2))
