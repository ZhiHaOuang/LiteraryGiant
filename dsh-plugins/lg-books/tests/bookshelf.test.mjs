import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,renameSync,realpathSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareDirectories,scanShelf,createShelf} from '../src/bookshelf.js'
import {createBook} from './fixture.mjs'
const fresh=()=>realpathSync(mkdtempSync(join(tmpdir(),'lg-shelf-')))
const folders=()=>prepareDirectories({booksDirectory:fresh(),libraryDirectory:fresh()})
test('independent folder selection loads the selected folders directly and never creates nested folders',()=>{
 const selected=folders();writeFileSync(join(selected.libraryDirectory,'keep.txt'),'author content')
 for(const name of ['A','B'])createBook(join(selected.booksDirectory,name)).db.close()
 mkdirSync(join(selected.booksDirectory,'unrecognized'));symlinkSync(join(selected.booksDirectory,'A'),join(selected.booksDirectory,'linked'))
 const shelf=scanShelf(selected);assert.equal(shelf.books.length,2);assert.equal(shelf.unavailable.length,2)
 assert.equal(shelf.booksPath,selected.booksDirectory);assert.equal(shelf.libraryPath,selected.libraryDirectory)
 assert.equal(readFileSync(join(selected.libraryDirectory,'keep.txt'),'utf8'),'author content')
 assert.equal(existsSync(join(selected.booksDirectory,'Books')),false);assert.equal(existsSync(join(selected.libraryDirectory,'Library')),false)
 assert.throws(()=>prepareDirectories({...selected,booksDirectory:'relative'}),/绝对/)
 assert.throws(()=>prepareDirectories({...selected,libraryDirectory:selected.booksDirectory}),/不同/)
 assert.throws(()=>prepareDirectories({...selected,libraryDirectory:join(selected.libraryDirectory,'missing')}))
 assert.equal(existsSync(join(selected.libraryDirectory,'missing')),false)
})
test('changing only Library preserves book selection and workspace identities across restart',async()=>{
 const selected=folders(),a=join(selected.booksDirectory,'A'),legacy=fresh();createBook(a).db.close();createBook(legacy).db.close()
 const records=[],registry={list:()=>records,async create(path,title){let item=records.find(r=>r.path===path);if(!item){item={id:'w'+records.length,path,title};records.push(item)}return item}}
 const config={...selected,projects:[a,legacy]},shelf=createShelf(config,()=>registry)
 await Promise.all([shelf.sync(),shelf.sync()]);assert.equal(records.length,2);assert.equal(shelf.list().length,2)
 createBook(join(selected.booksDirectory,'B')).db.close();await shelf.sync();assert.equal(records.length,3)
 const changed=prepareDirectories({...selected,libraryDirectory:fresh()});shelf.setDirectories(changed)
 const state=await shelf.sync();assert.equal(state.booksPath,selected.booksDirectory);assert.equal(state.libraryPath,changed.libraryDirectory);assert.equal(records.length,3)
 const restarted=createShelf({...config,...changed},()=>registry);assert.equal((await restarted.sync()).books.length,3);assert.equal(records.length,3)
 assert.equal(restarted.list().find(b=>b.path===legacy).external,true)
 renameSync(changed.libraryDirectory,changed.libraryDirectory+'-moved');assert.ok(restarted.snapshot().error)
})
test('previous root setting is read compatibly without creating missing directories',()=>{
 const root=fresh();mkdirSync(join(root,'Books'));mkdirSync(join(root,'Library'))
 const shelf=createShelf({rootDirectory:root},()=>null)
 assert.equal(shelf.snapshot().booksPath,join(root,'Books'));assert.equal(shelf.snapshot().libraryPath,join(root,'Library'))
 const empty=fresh();assert.ok(createShelf({rootDirectory:empty},()=>null).snapshot().error)
 assert.equal(existsSync(join(empty,'Books')),false)
})
test('workspace failure is visible without hiding readable books',async()=>{
 const selected=folders();createBook(join(selected.booksDirectory,'A')).db.close()
 const shelf=createShelf(selected,()=>({list:()=>[],create(){throw Error('disk unavailable')}}))
 const state=await shelf.sync();assert.equal(state.books.length,1);assert.equal(state.workspaceErrors[0].error,'disk unavailable')
})
