import {test} from 'node:test'
import assert from 'node:assert/strict'
import {matchedBook,bindWorkspaceBooks} from '../lg-brand/src/workspace-navigation.js'

test('workspace matches only valid books by exact path, never title',()=>{
 const workspaces=[{workspaceId:'a',path:'/books/A',title:'Same'},{workspaceId:'b',path:'/other',title:'Same'}]
 const books=[{path:'/books/A',title:'Same'},{path:'/broken',error:'unavailable'}]
 assert.equal(matchedBook('a',workspaces,books),books[0])
 assert.equal(matchedBook('b',workspaces,books),undefined)
 assert.equal(matchedBook('missing',workspaces,books),undefined)
 assert.equal(matchedBook('x',[{workspaceId:'x',path:'/broken'}],books),undefined)
})

test('book navigation expands once, preserves modifiers and restores listeners/attributes',async()=>{
 const handlers=new Map(),attrs=new Map(),opened=[]
 let expanded=false,toggles=0,disconnected=false,unsubscribed=false
 const row={getAttribute:key=>key==='data-row-key'?'workspace:a':String(expanded),querySelector:selector=>selector.includes('row-chevron')?{click(){toggles++;expanded=!expanded}}:label}
 const label={isConnected:true,getAttribute:key=>attrs.get(key)??null,setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),closest:selector=>selector.includes('workspace:')?row:label}
 const document={body:{},querySelectorAll:()=>[row],addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:k=>handlers.delete(k)}
 const window={MutationObserver:class{observe(){} disconnect(){disconnected=true}},addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:k=>handlers.delete(k)}
 let ready
 const loaded=new Promise(resolve=>{ready=resolve})
 const stop=bindWorkspaceBooks({document,window,workspaces:{list:{getSnapshot:()=>({items:[{workspaceId:'a',path:'/books/A'}]}),subscribe:()=>()=>{unsubscribed=true}}},readBooks:async()=>{ready();return [{path:'/books/A'}]},openBook:path=>opened.push(path)})
 await loaded;await new Promise(resolve=>setImmediate(resolve))
 assert.equal(attrs.get('role'),'link')
 const event={target:label,type:'click',button:0,preventDefault(){},stopPropagation(){}}
 handlers.get('click')({...event,metaKey:true})
 assert.equal(opened.length,0)
 handlers.get('click')(event);handlers.get('click')(event)
 handlers.get('keydown')({...event,type:'keydown',key:'Enter'})
 assert.deepEqual(opened,['/books/A','/books/A','/books/A'])
 assert.equal(toggles,1)
 stop()
 assert.equal(attrs.size,0);assert.equal(handlers.size,0)
 assert.ok(disconnected&&unsubscribed)
})
