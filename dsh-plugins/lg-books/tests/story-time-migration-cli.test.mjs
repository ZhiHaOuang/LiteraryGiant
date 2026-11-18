import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {createStoryFixture} from './story-data-fixture.mjs'
import {digest} from '../src/story-data/validate.js'

const script=fileURLToPath(new URL('../../scripts/migrate-story-time.mjs',import.meta.url))
const legacyContract=JSON.parse(readFileSync(new URL('../src/story-data/contract-v1.json',import.meta.url),'utf8'))
function fixture(){
 const parent=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-time-cli-'))
 const book=join(parent,'book');createStoryFixture(book)
 const db=new DatabaseSync(join(book,'.literarygiant/story.sqlite3'))
 db.prepare("UPDATE lg_story_data_meta SET value=? WHERE key='version'").run('1.0.0')
 db.prepare("UPDATE lg_story_data_meta SET value=? WHERE key='contract_hash'").run(digest(legacyContract))
 db.close()
 const backups=join(parent,'backups');mkdirSync(backups)
 return {book,backups,parent}
}
function cli(...args){
 const r=spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:30000})
 return {status:r.status,out:r.stdout.trim()?JSON.parse(r.stdout):null,error:r.stderr}
}
function snapshot(book){
 const db=new DatabaseSync(join(book,'.literarygiant/story.sqlite3'),{readOnly:true})
 try{return Object.fromEntries(['documents','document_versions','lg_story_data_records','lg_story_data_revisions','lg_story_data_runs','lg_story_data_meta','lg_story_data_operations'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))}
 finally{db.close()}
}
test('CLI preview is read-only and metadata migration preserves manuscript and all story history',()=>{
 const f=fixture(),before=snapshot(f.book),p=cli('--book',f.book)
 assert.equal(p.status,0,p.error);assert.equal(p.out.needed,true);assert.equal(p.out.from_version,'1.0.0')
 assert.deepEqual(snapshot(f.book),before)
 const a=cli('--book',f.book,'--apply','--token',p.out.token,'--backup-dir',f.backups)
 assert.equal(a.status,0,a.error);assert.equal(a.out.mode,'applied')
 const after=snapshot(f.book)
 for(const table of ['documents','document_versions','lg_story_data_records','lg_story_data_revisions','lg_story_data_runs'])assert.deepEqual(after[table],before[table],table)
 assert.deepEqual(snapshot(a.out.backup),before)
 assert.equal(JSON.parse(readFileSync(join(a.out.backup,'.literarygiant/project.json'))).project_id,'test-book')
 assert.deepEqual(readdirSync(join(a.out.backup,'.literarygiant')).sort(),['project.json','story.sqlite3'])
 const current=cli('--book',f.book);assert.equal(current.out.needed,false)
 const repeated=cli('--book',f.book,'--apply','--token',current.out.token,'--backup-dir',f.backups)
 assert.equal(repeated.status,0,repeated.error);assert.equal(repeated.out.mode,'unchanged')
 assert.deepEqual(snapshot(f.book),after);assert.equal(readdirSync(f.backups).length,1)
})
test('CLI rejects missing backup, in-book/symlink backup and stale source token without writes',()=>{
 const f=fixture(),p=cli('--book',f.book),before=snapshot(f.book)
 assert.equal(p.status,0,p.error)
 const noBackup=cli('--book',f.book,'--apply','--token',p.out.token)
 assert.notEqual(noBackup.status,0)
 const inBook=join(f.book,'backup');mkdirSync(inBook)
 const alias=join(f.parent,'alias');symlinkSync(inBook,alias,'dir')
 for(const path of [inBook,alias]){
  const r=cli('--book',f.book,'--apply','--token',p.out.token,'--backup-dir',path)
  assert.notEqual(r.status,0);assert.match(r.error,/作品之外/)
 }
 assert.deepEqual(snapshot(f.book),before)
 const db=new DatabaseSync(join(f.book,'.literarygiant/story.sqlite3'))
 db.prepare("UPDATE document_versions SET content=content||'补充正文' WHERE id=1").run();db.close()
 const changed=snapshot(f.book)
 const stale=cli('--book',f.book,'--apply','--token',p.out.token,'--backup-dir',f.backups)
 assert.notEqual(stale.status,0);assert.match(stale.error,/预览已变化|预检存在问题/)
 assert.deepEqual(snapshot(f.book),changed);assert.equal(readdirSync(f.backups).length,0)
})
test('CLI validates arguments and help does not require a book',()=>{
 assert.equal(cli('--help').status,0)
 for(const args of [[],['--book','relative'],['--other'],['--book','/tmp','--book','/tmp'],['--book','/tmp','--token','x']])assert.notEqual(cli(...args).status,0)
})
