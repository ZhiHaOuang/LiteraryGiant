import test from 'node:test'
import assert from 'node:assert/strict'
import {bindBookActions} from '../src/workspace-navigation.js'

function setup(fail){
 const handlers={},calls=[],book={id:'book-1',path:'/book',name:'Canonical name'},workspace={workspaceId:'w1',path:'/book',title:'Custom name'}
 let changed=0,native=0
 const ctx={on:(event,fn)=>{handlers[event]=fn},workspaces:{list:{getSnapshot:()=>({items:[workspace,{workspaceId:'ordinary',path:'/ordinary'}]})}}}
 const request=async input=>{calls.push(input);if(fail)throw Error('Book service unavailable');return input.action==='list'?[book]:{workspaceErrors:[]}}
 bindBookActions(ctx,request,()=>changed++)
 return {handlers,calls,book,get changed(){return changed},get native(){return native},next:async()=>{native++}}
}
test('native rename and remove use canonical book identity and publish only after saving',async()=>{
 const s=setup()
 await s.handlers['uiWorkspace/rename']('w1','New title',s.next)
 assert.deepEqual(s.calls[1],{action:'rename',path:'/book',projectId:'book-1',expectedName:'Canonical name',name:'New title'})
 await s.handlers['uiWorkspace/delete']('w1',s.next)
 assert.deepEqual(s.calls[3],{action:'remove',path:'/book',id:'book-1',confirmed:true})
 assert.equal(s.native,0);assert.equal(s.changed,2)
})
test('ordinary workspace mutations delegate; unavailable book service never falls through to native deletion',async()=>{
 const s=setup()
 await s.handlers['uiWorkspace/rename']('ordinary','Native',s.next)
 await s.handlers['uiWorkspace/delete']('ordinary',s.next)
 assert.equal(s.native,2);assert.equal(s.changed,0)
 const broken=setup(true)
 await assert.rejects(broken.handlers['uiWorkspace/delete']('w1',broken.next),/unavailable/)
 assert.equal(broken.native,0);assert.equal(broken.changed,0)
})
