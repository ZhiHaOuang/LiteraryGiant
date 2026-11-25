import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {digest} from '../src/contracts.js'
import {createOutline} from '../src/service.js'
import {bookInventory,overview} from '../src/inventory.js'

test('cross-book totals count only readable books; custom summary modules and second-page details are counted once',()=>{
  const root=mkdtempSync(join(tmpdir(),'lg-inventory-')),paths=['a','b'].map(n=>join(root,n))
  paths.forEach(path=>createBook(path).db.close())
  const books={list:(options={})=>[...paths.map((path,i)=>({path,name:String(i),archived:i===1})),{name:'缺失目录',error:'不可读'}].filter(book=>options.includeArchived||!book.archived),
    changeState:(path,f)=>accessState(path,true,f),readState:(path,f)=>accessState(path,false,f)}
  const outline=createOutline(books)
  const item={section:'world',module:'custom@1.note',expected_revision:0,basis:'text',text:'海风停了。',links:[],
    evidence:[{document_id:1,version_id:1,sha256:digest('林澈关上灯。海风停了。'),quote:'海风停了。',paragraph:1}]}
  for(const path of paths){
    outline.enablePack(path,{id:'custom',version:1,modules:{note:['world']}})
    const size=path===paths[0]?31:1
    for(let start=0;start<size;start+=20){
      const changes=Array.from({length:Math.min(20,size-start)},(_,i)=>({...item,id:'wind-'+(start+i),title:'海风 '+(start+i)}))
      const {token}=outline.propose(path,{schema:'lg.outline.change.v1',book_id:'test-book',beat:'关灯',changes},'analysis')
      outline.review(path,token,{decision:'approved',reason:'有据'},'review');outline.commit(path,token)
    }
  }
  const all=overview(books)
  const english=overview(books,{locale:'en'}).protocol
  assert.doesNotMatch(JSON.stringify(english),/\p{Script=Han}/u)
  assert.match(all.protocol.groups[0].label,/\p{Script=Han}/u)
  const ids=protocol=>protocol.groups.map(group=>[group.module,group.facets.map(f=>f.id)])
  assert.deepEqual(ids(english),ids(all.protocol))
  assert.equal(english.rules.length,all.protocol.rules.length)
  assert.equal(all.totals.main,31)
  assert.ok(all.books.every(book=>!book.archived))
  assert.equal(all.books[1].error,'不可读')
  const first=bookInventory(books,paths[0],{}),next=bookInventory(books,paths[0],{offset:30,module:item.module})
  assert.equal(first.total,31);assert.equal(first.items.length,30);assert.equal(next.items.length,1)
  assert.ok(!first.items.some(i=>i.id===next.items[0].id))
  assert.equal(next.packs[1].id,'custom')
  assert.equal(bookInventory(books,paths[1],{}).total,1)
})
