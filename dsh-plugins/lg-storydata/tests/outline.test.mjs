import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import * as books from '../../lg-books/index.js'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {digest} from '../src/contracts.js'
import * as outline from '../index.js'

const evidence = {document_id:1,version_id:1,sha256:digest('林澈关上灯。海风停了。'),paragraph:1,quote:'林澈关上灯。'}
const person = {id:'lin',section:'people',title:'林澈',module:'core@1.summary',expected_revision:0,text:'已关灯。',basis:'text',links:['light'],evidence:[evidence]}
const plot = {...person,id:'light',title:'熄灯',section:'plot',text:'灯已熄灭。',links:[]}
const world = {...plot,id:'wind',section:'world',title:'海风',text:'风已停。',evidence:[{...evidence,quote:'海风停了。'}]}
const change = (...changes)=>({schema:'lg.outline.change.v1',book_id:'test-book',beat:'关灯之后',changes})
async function host(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(),'lg-outline-')))
  createBook(path).db.close()
  const ctx = new Context(), routes = new Map()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin(c=>{
    c.provide('configEditor',{edit(){throw Error('unexpected config write')}})
    c.provide('connection',{fetch:{register(route){routes.set(route.path,route);return ()=>routes.delete(route.path)}}})
  })
  await ctx.plugin(books,{projects:[path]})
  const mount = ()=>ctx.plugin(outline)
  const fiber = mount(); await fiber
  const call = async body=>(await routes.get('/api/lg/outline').fetch(new Request('http://localhost/api/lg/outline',
    {method:'POST',body:JSON.stringify({action:'main',path,...body})}))).json()
  return {path,api:ctx.literaryOutline,books:ctx.literaryBooks,ctx,call,routes,fiber,mount}
}
function approved(api,path,batch) {
  const {token} = api.propose(path,batch,'analyst')
  api.review(path,token,{decision:'approved',reason:'逐项核对了依据和旧档。'},'reviewer')
  return token
}

test('registered host: independent review, atomic cross-section Main, restart, source history and no Canon writes',async t=>{
  const {api,path,books,ctx,call,routes,fiber,mount} = await host(t)
  const initial = books.snapshot(path)
  const storageRoute=routes.get('/api/lg/storydata')
  const measured=await (await storageRoute.fetch(new Request('http://localhost/api/lg/storydata',{
    method:'POST',body:JSON.stringify({action:'storage'})
  }))).json()
  assert.equal(measured.value.version,'lg.storydata.space.v1')
  assert.equal(measured.value.bookCount,1)
  assert.equal(measured.value.history.chapter[0].position,3)
  assert.equal((await call({})).value.total,0)
  assert.equal(books.readState(path,db=>db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'lg_outline_%'").get().n),0)
  const batch = change(person,plot,world)
  const {token} = api.propose(path,batch,'analyst')
  assert.equal(api.inspect(path,token).changes[0].before,null)
  assert.equal(api.main(path).total,0)
  assert.throws(()=>api.commit(path,token),/尚未通过/)
  assert.throws(()=>api.review(path,token,{decision:'approved',reason:'ok'},'analyst'),/独立/)
  assert.equal(approved(api,path,batch),token)
  assert.equal(api.main(path).total,0)
  assert.deepEqual(api.commit(path,token),api.commit(path,token))
  assert.equal(api.propose(path,batch,'analyst').status,'committed')
  const {items} = (await call({options:{section:'people'}})).value
  assert.deepEqual(items[0].links,['light'])
  assert.deepEqual(items[0].related,[{id:'light',title:'熄灯'}])
  assert.equal((await call({options:{audience:'character'}})).ok,false)
  assert.equal(items[0].freshness,'current')
  assert.equal(items[0].evidence,undefined)
  assert.equal(items[0].standing,'reviewed_summary')
  const next = {...person,expected_revision:1,text:'关灯后留在码头。',basis:'inference'}
  const update = approved(api,path,change(next))
  assert.equal(api.inspect(path,update).changes[0].before.text,person.text)
  api.commit(path,update)
  await fiber.dispose()
  assert.equal(routes.has('/api/lg/outline'),false)
  await mount()
  assert.equal((await call({})).value.total,3)
  const history = ctx.literaryOutline.history(path,{id:'lin',module:person.module})
  assert.deepEqual(history.map(r=>r.revision),[2,1])
  assert.deepEqual(history[1].item.evidence,[evidence])
  assert.equal(history[0].reviewer,'reviewer')
  assert.equal(books.snapshot(path).revision,initial.revision)
  assert.deepEqual(books.snapshot(path).counts,initial.counts)
  assert.equal((await call({action:'commit',token})).ok,false)
  assert.equal((await call({path:tmpdir()})).ok,false)
})

test('stale candidates cannot partially advance a joint change; a stale source can be rebound',async t=>{
  const {api,path,books} = await host(t)
  const token = approved(api,path,change(person,plot))
  api.commit(path,approved(api,path,change({...plot,text:'暂时熄灯。'})))
  assert.throws(()=>api.commit(path,token),/版本已变化/)
  assert.equal(api.main(path,{section:'people'}).total,0)
  const update = approved(api,path,change({...plot,expected_revision:1}))
  const revisedText = '林澈关上灯。雾升起来。'
  const version = books.changeState(path,db=>{
    const id = Number(db.prepare("INSERT INTO document_versions(document_id,version_number,state,content,reason,created_at) VALUES(1,3,'draft',?,'fixture','now')").run(revisedText).lastInsertRowid)
    db.prepare('UPDATE documents SET active_version_id=? WHERE id=1').run(id)
    return id
  })
  assert.throws(()=>api.commit(path,update),/原文依据/)
  assert.equal(api.main(path).items[0].freshness,'stale')
  const refreshed = {...plot,text:'暂时熄灯。',expected_revision:1,evidence:[{...evidence,version_id:version,sha256:digest(revisedText)}]}
  api.commit(path,approved(api,path,change(refreshed)))
  assert.equal(api.main(path).items[0].freshness,'current')
  assert.deepEqual(api.history(path,{id:'light',module:plot.module}).map(r=>r.item.evidence[0].version_id),[version,1])
})

test('selection rejects bad references, fake evidence and invalid schema; rejection and no-change do not grow Main',async t=>{
  const {api,path} = await host(t)
  const propose = (...items)=>api.propose(path,change(...items),'analyst')
  assert.throws(()=>propose(person),/关联目标/)
  assert.throws(()=>propose(plot,plot),/重复/)
  assert.throws(()=>propose({...world,basis:'author'}),/协议/)
  assert.throws(()=>propose({...world,evidence:[{...evidence,quote:'暴雨'}]}),/依据/)
  assert.throws(()=>propose({...world,evidence:[{...evidence,version_id:8}]}),/依据/)
  assert.throws(()=>api.propose(path,{...change(plot),book_id:'other'},'analyst'),/作品标识/)
  assert.equal(propose().status,'no_change')
  const {token} = propose(world)
  api.review(path,token,{decision:'rejected',reason:'本次海风没有长期影响。'},'reviewer')
  assert.throws(()=>api.commit(path,token),/未通过/)
  assert.equal(api.inspect(path,token).status,'rejected')
  api.commit(path,approved(api,path,change(plot)))
  assert.equal(propose({...plot,expected_revision:1}).status,'no_change')
  assert.equal(api.history(path,{id:'light',module:plot.module}).length,1)
})

test('book-specific modules are pinned and restricted to declared sections',async t=>{
  const {api,path} = await host(t)
  const other = await host(t), spec = {id:'example',version:1,modules:{note:['people']}}
  const entry = {...person,module:'example@1.note',links:[]}
  assert.throws(()=>api.propose(path,change(entry),'a'),/未.*启用/)
  api.enablePack(path,spec)
  assert.deepEqual(api.packs(path)[1],spec)
  assert.deepEqual(other.api.packs(other.path).map(p=>p.id),['core'])
  assert.throws(()=>api.enablePack(path,{...spec,version:2}),/固定/)
  assert.throws(()=>api.propose(path,change({...entry,section:'world'}),'a'),/启用/)
  api.commit(path,approved(api,path,change(entry)))
  assert.equal(api.main(path,{id:'lin'}).items[0].module,'example@1.note')
})

test('final manuscript versions remain valid evidence, archived documents mark their summaries stale',async t=>{
  const {api,path,books} = await host(t)
  books.changeState(path,db=>{
    db.prepare("UPDATE documents SET state='final' WHERE id=1").run()
    db.prepare("UPDATE document_versions SET state='final' WHERE id=1").run()
  })
  api.commit(path,approved(api,path,change(world)))
  assert.equal(api.main(path).items[0].freshness,'current')
  books.changeState(path,db=>db.prepare("UPDATE documents SET state='archived' WHERE id=1").run())
  assert.equal(api.main(path).items[0].freshness,'stale')
})

test('local importer and plugin route share a persisted review across processes',async t=>{
  const {path,call} = await host(t)
  const script = fileURLToPath(new URL('../../scripts/outline.mjs',import.meta.url))
  const run = (action,args=[],data)=>JSON.parse(execFileSync(process.execPath,[script,action,path,...args],{encoding:'utf8',input:data && JSON.stringify(data)}))
  const {token} = run('propose',['analysis-run'],change(person,plot))
  assert.equal(run('inspect',[token]).changes.length,2)
  run('review',[token,'review-run'],{decision:'approved',reason:'两处依据与关联均已核对。'})
  run('commit',[token])
  assert.equal((await call({options:{section:'plot'}})).value.items[0].title,'熄灯')
  assert.equal(run('history',['lin',person.module])[0].token,token)
})


test('character view keeps ordered facets and reviewed entry changes independently of legacy summaries',async t=>{
  const {api,path,call}=await host(t)
  const groups=(await call({action:'character',options:{id:'lin'}})).value.groups
  assert.equal(groups.length,8)
  assert.equal(groups.flatMap(g=>g.facets).length,40)
  assert.ok(groups.every(g=>g.item===null))
  const item={...person,module:'core@1.milestones',entries:[{
    key:'first-light',facet:'role',value:'关灯的人。',tags:['行动者'],nature:'observation',scope:'关灯当场',sources:[1],event_id:'light'
  }]}
  for (const changes of [
    [{...item,entries:undefined},plot],
    [{...item,entries:[{...item.entries[0],sources:[2]}]},plot],
    [{...item,entries:[{...item.entries[0],facet:'mastery'}]},plot],
    [{...item,entries:[{...item.entries[0],event_id:'wind'}]},plot],
    [item,{...plot,section:'world'}]
  ]) assert.throws(()=>api.propose(path,change(...changes),'a'))
  api.commit(path,approved(api,path,change(person,item,plot)))
  const read=()=>api.character(path,{id:'lin'}).groups.at(-1).item
  assert.equal(read().related[0].id,'light')
  assert.equal(read().entries[0].sources,undefined)
  assert.equal(read().freshness,'current')
  const next={...item,expected_revision:1,entries:[{...item.entries[0],tags:['决策者']}]}
  api.commit(path,approved(api,path,change(next)))
  assert.equal(read().revision,2)
  assert.deepEqual(read().entries[0].tags,['决策者'])
  assert.equal(api.propose(path,change({...next,expected_revision:2}),'a').status,'no_change')
  assert.deepEqual(api.main(path,{section:'people',id:'lin',other_modules:true}).items.map(x=>x.module),[person.module])
  assert.deepEqual(api.history(path,{id:'lin',module:item.module})[1].item.entries[0].sources,[1])
  assert.equal((await call({action:'character',options:{id:'lin',audience:'character'}})).ok,false)
})

test('current character modules reject incomplete epistemic, goal, relation and event semantics',async t=>{
  const {api,path}=await host(t)
  const base={key:'p',value:'在码头。',tags:[],nature:'observation',scope:'当前场景',sources:[1]}
  const check=(module,facet,extra={})=>api.propose(path,change({...person,links:[],module:'core@1.'+module,entries:[{...base,facet,...extra}]}),'a')
  assert.throws(()=>check('knowledge','proposition'),/态度/)
  assert.throws(()=>check('goals','objective'),/跨度/)
  assert.throws(()=>check('relationships','duty',{direction:'incoming'}),/对象/)
  assert.throws(()=>check('relationships','duty',{direction:'incoming',target:'未登记',target_id:'absent',visibility:'unknown'}),/人物引用/)
  assert.throws(()=>check('milestones','sequence',{event_relation:'after'}),/经历关联/)
  assert.throws(()=>check('summary','role'),/不接受/)
})

test('inventory measures current entries, distinguishes unused facets and legacy summaries, and does not initialize empty books',async t=>{
  const {api,path,routes,books}=await host(t)
  const route=routes.get('/api/lg/storydata')
  async function read(input){
    const res=await route.fetch(new Request('http://localhost/api/lg/storydata',{method:'POST',body:JSON.stringify(input)}))
    return res.json()
  }
  assert.equal((await read({action:'overview'})).value.totals.main,0)
  assert.equal(books.readState(path,db=>db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'lg_outline_%'").get().n),0)
  const group={...person,module:'core@1.identity',entries:[{key:'given',facet:'name',value:'林澈',tags:['本名'],nature:'observation',scope:'第一章',sources:[1]}]}
  const token=approved(api,path,change(group,plot))
  assert.equal(api.overview().books[0].main,0)
  api.commit(path,token)
  api.commit(path,approved(api,path,change({...group,expected_revision:1,text:'人物名称',entries:[...group.entries,{...group.entries[0],key:'alias',value:'阿澈'}]})))
  const data=(await read({action:'overview'})).value
  assert.equal(data.protocol.groups.flatMap(g=>g.facets).length,40)
  assert.deepEqual(data.totals,{main:3,records:0})
  const selected=(await read({action:'book',path,options:{module:group.module,facet:'name'}})).value
  assert.equal(selected.total,2)
  assert.deepEqual(selected.items.map(i=>[i.value,i.revision]),[['林澈',2],['阿澈',2]])
  assert.equal(api.book(path,{module:group.module,facet:'background'}).total,0)
  assert.equal(api.book(path,{offset:31}).items.length,0)
  assert.equal((await read({action:'book',path:tmpdir()})).ok,false)
  assert.equal((await read({action:'commit',path,token})).ok,false)
})
