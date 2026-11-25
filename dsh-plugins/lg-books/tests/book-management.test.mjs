import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createBook} from './fixture.mjs'
import {createShelf} from '../src/bookshelf.js'
import {createBookManagement} from '../src/book-management.js'
import {apply} from '../index.js'
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'lg-book-management-')))
const fingerprint=dir=>Object.fromEntries(readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const p=join(e.parentPath,e.name);return [p.slice(dir.length),createHash('sha256').update(readFileSync(p)).digest('hex')]}))
function setup(){
 const base=root(),booksDirectory=join(base,'Books'),libraryDirectory=join(base,'Library');mkdirSync(booksDirectory);mkdirSync(libraryDirectory)
 const path=join(booksDirectory,'Novel');createBook(path).db.close()
 let config={booksDirectory,libraryDirectory,projects:[]},fail=false
 const records=[],registry={list:()=>[...records],async create(path,title){
  let record=records.find(r=>r.path===path)
  if(!record){record={id:randomUUID(),path,title,sessionIds:[],async attachSession(id){if(!this.sessionIds.includes(id))this.sessionIds.unshift(id)}};records.push(record)}
  return record
 },async delete(id){const index=records.findIndex(r=>r.id===id);if(index>=0)records.splice(index,1)}}
 const persist=async update=>{if(fail)throw Error('save failed');config=update(config);shelf.setCatalog(config)}
 const shelf=createShelf(config,()=>registry,persist),service=createBookManagement(shelf,persist)
 return {base,path,shelf,service,records,registry,persist,config:()=>config,fail:()=>{fail=true}}
}
test('archive, restore and remove persist across refresh/restart without changing a single book file',async()=>{
 const s=setup(),before=fingerprint(s.path),book=s.shelf.list()[0]
 await s.shelf.sync()
 const original=await s.registry.create(s.path,'ignored')
 original.title='Custom book workspace';original.sessionIds=['newer-session','older-session']
 const unrelated=await s.registry.create(s.base,'Unrelated')
 await assert.rejects(s.service.change({action:'remove',path:s.path,id:book.id}),/确认/)
 await assert.rejects(s.service.change({action:'remove',path:s.path,id:'stale',confirmed:true}),/变化/)
 await assert.rejects(s.service.change({action:'remove',path:s.base,id:book.id,confirmed:true}),/变化/)
 await s.service.change({action:'archive',path:s.path,id:book.id,confirmed:true})
 assert.deepEqual(s.records.map(r=>r.id),[unrelated.id]);assert.deepEqual(s.config().shelvedWorkspaces[0].sessionIds,original.sessionIds)
 assert.equal(s.shelf.list().length,0);assert.equal((await s.shelf.sync()).books[0].archived,true)
 let restarted=createShelf(s.config(),()=>null);assert.equal(restarted.list().length,0);assert.equal((await restarted.sync()).books[0].archived,true)
 await s.service.change({action:'restore',path:s.path,id:book.id,confirmed:true});assert.equal(s.shelf.list().length,1)
 const restored=s.records.find(r=>r.path===s.path);assert.deepEqual(restored.sessionIds,original.sessionIds);assert.equal(restored.title,book.name)
 await s.service.change({action:'remove',path:s.path,id:book.id,confirmed:true})
 assert.deepEqual(s.records.map(r=>r.id),[unrelated.id])
 assert.equal((await s.shelf.sync()).books.length,0);assert.equal(createShelf(s.config(),()=>null).list().length,0)
 await s.service.add(s.path);assert.equal(s.shelf.list().length,1);assert.deepEqual(s.records.find(r=>r.path===s.path).sessionIds,original.sessionIds)
 assert.deepEqual(fingerprint(s.path),before)
})
test('failed config save leaves membership unchanged and serialized edits preserve other books',async()=>{
 const s=setup(),book=s.shelf.list()[0];s.fail()
 await assert.rejects(s.service.change({action:'archive',path:s.path,id:book.id,confirmed:true}),/save failed/)
 assert.equal(s.shelf.list().length,1)
 const other=setup(),b=join(other.base,'External');createBook(b).db.close()
 await Promise.all([other.service.add(other.path),other.service.add(b)])
 assert.equal(other.config().projects.length,2)
})
test('author API supports create preview/retry and confirmed shelf changes; removed books cannot be read',async()=>{
 const base=root(),booksDirectory=join(base,'Books'),libraryDirectory=join(base,'Library');mkdirSync(booksDirectory);mkdirSync(libraryDirectory)
 let config={booksDirectory,libraryDirectory,projects:[]};const routes=new Map(),services=new Map()
 const ctx={
  fiber:{entry:{}},
  configEditor:{async edit(entry,update){config=update(config)}},
  connection:{fetch:{register(route){routes.set(route.path,route);return()=>{}}}},
  get:name=>services.get(name),provide:(name,value)=>services.set(name,value),effect:fn=>fn(),inject:(deps,fn)=>fn(ctx),
 }
 apply(ctx,config)
 const call=async input=>{const r=await routes.get('/api/lg/books').fetch(new Request('http://local/api/lg/books',{method:'POST',body:JSON.stringify(input)}));return {status:r.status,...await r.json()}}
 const path=join(booksDirectory,'New'),preview=await call({action:'create-preview',path,name:'新书'})
 assert.equal(preview.ok,true);const create={action:'create',path,name:'新书',token:preview.value.token,operation:randomUUID()}
 const first=await call(create),retry=await call(create);assert.equal(first.ok,true);assert.equal(retry.value.id,first.value.id)
 const change={path,id:first.value.id,confirmed:true}
 assert.equal((await call({action:'archive',...change})).ok,true)
 assert.equal((await call({action:'read',path})).ok,true)
 assert.equal((await call({action:'remove',...change})).ok,true)
 assert.equal((await call({action:'read',path})).status,400)
 assert.equal((await call({action:'add',path})).ok,true)
 assert.equal((await call({action:'shelf'})).value.books.length,1)
 assert.equal((await call({action:'read',path})).ok,true)
})

test('startup reconciles old exclusions, retains grouping across restart and retries failed deletes',async()=>{
 const s=setup();await s.shelf.sync();s.records[0].sessionIds=['session-1']
 await s.persist(current=>({...current,archivedProjects:[s.path]}))
 let saved=s.config(),restarted
 const save=async update=>{saved=update(saved);restarted.setCatalog(saved)}
 restarted=createShelf(saved,()=>s.registry,save)
 const remove=s.registry.delete;s.registry.delete=async()=>{throw Error('registry busy')}
 assert.match((await restarted.sync()).workspaceErrors[0].error,/registry busy/)
 assert.equal(s.records.length,1);assert.deepEqual(saved.shelvedWorkspaces[0].sessionIds,['session-1'])
 s.registry.delete=remove
 await restarted.sync();assert.equal(s.records.length,0)
 restarted=createShelf(saved,()=>s.registry,save)
 await createBookManagement(restarted,save).change({action:'restore',path:s.path,id:restarted.list({includeArchived:true})[0].id,confirmed:true})
 assert.deepEqual(s.records[0].sessionIds,['session-1']);assert.deepEqual(saved.shelvedWorkspaces,[])
})
test('a failed grouping backup never deletes a workspace',async()=>{
 const s=setup();await s.shelf.sync()
 await s.persist(current=>({...current,removedProjects:[s.path]}));s.fail()
 assert.match((await s.shelf.sync()).workspaceErrors[0].error,/save failed/)
 assert.equal(s.records.length,1)
})
