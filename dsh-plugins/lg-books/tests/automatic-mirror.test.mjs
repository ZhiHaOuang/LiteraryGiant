import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createBook } from './fixture.mjs'
import { writeManuscript } from '../src/write.js'
import { readManuscript, digest } from '../src/manuscript.js'
import { chapterFile, retryChapterMirror } from '../src/chapter-files.js'

function setup(t) {
  const path=realpathSync(mkdtempSync(join(tmpdir(),'lg-author-mirror-'))), {db}=createBook(path)
  t.after(()=>db.close())
  const file=join(path,'manuscript','chapters','doc-1.md')
  const input=(action,document,content='作者修订的正文。')=>({action,document,content,reason:'作者修改',operation:randomUUID(),token:readManuscript(path,document).token})
  const save=request=>writeManuscript(path,request)
  const preview=()=>chapterFile(path,{action:'chapter-file-preview',document:1})
  const count=()=>db.prepare('SELECT count(*) AS n FROM document_versions').get().n
  return {path,db,file,input,save,preview,count}
}

test('author edits create the chapter mirror, refresh on a scene edit and return the same durable receipt on replay', t=>{
  const f=setup(t), initial=f.save(f.input('edit',1,'港口晴了。'))
  assert.equal(initial.sync,'synchronized');assert.equal(initial.chapter,1);assert.equal(initial.mirrorPath,f.file)
  const first=readFileSync(f.file);assert.match(first.toString(),/港口晴了。/)
  const input=f.input('edit',2,'外面起风。'),saved=f.save(input)
  assert.equal(saved.sync,'synchronized');assert.deepEqual(readFileSync(saved.backup),first)
  assert.match(readFileSync(f.file,'utf8'),/港口晴了。[\s\S]*外面起风。/);assert.equal(f.preview().state,'clean')
  const external='外部作者继续编辑。';writeFileSync(f.file,external)
  const before=f.count();assert.deepEqual(f.save(input),saved);assert.equal(f.count(),before)
  assert.equal(readFileSync(f.file,'utf8'),external)
})

test('candidates and rejections leave files alone; only author acceptance projects the selected version',t=>{
  const f=setup(t),candidate=f.save(f.input('candidate',1,'保留的候选。'))
  assert.equal(candidate.sync,'not-needed');assert.ok(!existsSync(f.file))
  const rejected=f.save(f.input('candidate',1,'舍弃的想法。'))
  f.save({...f.input('reject',1),version:rejected.version});assert.ok(!existsSync(f.file))
  const result=f.save({...f.input('accept',1),version:candidate.version})
  assert.equal(result.sync,'synchronized');assert.match(readFileSync(f.file,'utf8'),/保留的候选/)
  assert.doesNotMatch(readFileSync(f.file,'utf8'),/舍弃的想法/)
})

test('untracked and externally edited files require author reconciliation while SQLite records the edit',t=>{
  for(const tracked of [false,true]){
    const f=setup(t)
    if(tracked)f.save(f.input('edit',1,'第一次保存。'))
    else mkdirSync(join(f.path,'manuscript','chapters'),{recursive:true})
    const external=Buffer.from('外部稿件。\r\n');writeFileSync(f.file,external)
    const input=f.input('edit',1,'作者另存了新版本。'),saved=f.save(input)
    assert.equal(saved.sync,'mirror-review');assert.equal(saved.mirrorState,tracked?'conflict':'untracked')
    assert.deepEqual(readFileSync(f.file),external);assert.equal(readManuscript(f.path,1).document.activeVersion,saved.version)
    assert.deepEqual(f.save(input),saved);assert.equal(f.preview().pendingOperation,undefined)
  }
})

test('filesystem failure returns a committed version; reopening and retrying synchronizes without another manuscript write',t=>{
  const f=setup(t),obstruction=join(f.path,'manuscript');writeFileSync(obstruction,'需要保留的外部文件')
  const input=f.input('edit',1),saved=f.save(input)
  assert.equal(saved.sync,'mirror-pending');assert.ok(saved.syncError)
  assert.equal(readManuscript(f.path,1).document.activeVersion,saved.version)
  renameSync(obstruction,join(f.path,'obstruction'))
  assert.equal(f.preview().pendingOperation,input.operation)
  assert.throws(()=>retryChapterMirror(f.path,3,input.operation),/本章/)
  const count=f.count(),finished=retryChapterMirror(f.path,1,input.operation)
  assert.equal(f.count(),count);assert.equal(finished.sync,'synchronized')
  assert.deepEqual(f.save(input),finished);assert.equal(f.preview().pendingOperation,undefined)
  assert.equal(f.preview().state,'clean')
})

test('pending replay cannot roll a later author version back on disk',t=>{
  const f=setup(t),block=join(f.path,'manuscript');writeFileSync(block,'阻塞')
  const input=f.input('edit',1,'前一版');assert.equal(f.save(input).sync,'mirror-pending')
  renameSync(block,join(f.path,'old-block'))
  const latest=f.save(f.input('edit',1,'后一版'));assert.equal(latest.sync,'synchronized')
  assert.equal(f.save(input).sync,'superseded');assert.match(readFileSync(f.file,'utf8'),/后一版/)
  assert.equal(f.preview().pendingOperation,undefined)
})

test('receipts from before automatic sync remain replayable without starting a new file operation',t=>{
  const f=setup(t),input=f.input('edit',1)
  const old={operation:input.operation,document:1,version:1,action:'edit',changesManuscript:true,sync:'database-saved-files-unchanged'}
  f.db.exec('CREATE TABLE lg_plugin_operations(id TEXT PRIMARY KEY,signature TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)')
  f.db.prepare("INSERT INTO lg_plugin_operations VALUES(?,?,?,'')").run(input.operation,digest(input),JSON.stringify(old))
  assert.deepEqual(f.save(input),old);assert.ok(!existsSync(f.file))
})

test('when the file is refreshed before its receipt can commit, retry recognizes the exact tracked file',t=>{
  const f=setup(t)
  f.save(f.input('edit',1,'旧版正文。'))
  const original=readFileSync(f.file)
  f.db.exec("CREATE TRIGGER interrupt_receipt BEFORE UPDATE ON lg_plugin_operations BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END")
  const input=f.input('edit',1,'已提交的新正文。'),partial=f.save(input)
  assert.equal(partial.sync,'mirror-pending');assert.match(partial.syncError,/receipt unavailable/)
  assert.match(readFileSync(f.file,'utf8'),/已提交的新正文/)
  f.db.exec('DROP TRIGGER interrupt_receipt')
  const backups=join(f.path,'.literarygiant','chapter-sync-backups'),dirs=readdirSync(backups)
  assert.equal(dirs.length,1);assert.deepEqual(readFileSync(join(backups,dirs[0],'previous.md')),original)
  const count=f.count();assert.equal(f.save(input).sync,'synchronized')
  assert.equal(f.preview().state,'clean');assert.equal(f.count(),count)
  assert.deepEqual(readdirSync(backups),dirs)
})

test('editing an old candidate cannot bypass adoption guards or publish its prose as a direct author edit',t=>{
  const f=setup(t)
  const input={...f.input('edit',1,'改过一个字的旧候选。'),sourceVersion:8}
  assert.throws(()=>f.save(input),/先保存为候选/)
  assert.throws(()=>f.save({...input,sourceVersion:undefined,version:8}),/先保存为候选/)
  assert.throws(()=>f.save({...input,sourceVersion:1,version:8}),/来源不一致/)
  assert.ok(!existsSync(f.file));assert.equal(f.count(),8)
  const revised=f.save({...input,action:'candidate',operation:randomUUID()})
  assert.equal(revised.sync,'not-needed')
  assert.throws(()=>f.save({...f.input('accept',1),version:revised.version}),/审批规则/)
  assert.equal(readManuscript(f.path,1).document.activeVersion,1);assert.ok(!existsSync(f.file))
})
