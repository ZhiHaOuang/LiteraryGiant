import test from 'node:test'
import assert from 'node:assert/strict'
import {bindBookshelfEntry} from '../lg-dashboard/src/navigation.js'
import lines from '../lg-dashboard/src/companion-lines.json' with {type:'json'}
import {dialoguePairs,dialogueScenes} from '../lg-dashboard/src/companion-dialogue.js'
test('Bookshelf activation resets book view, including repeat clicks; other controls stay native',()=>{
 let listener,count=0,removed=false
 const document={addEventListener(type,fn,capture){assert.equal(type,'click');assert.equal(capture,true);listener=fn},removeEventListener(type,fn,capture){removed=fn===listener&&capture}}
 const stop=bindBookshelfEntry(document,()=>count++)
 const event={button:0,target:{closest:()=>({querySelector:()=>({})})}}
 listener(event);listener(event)
 listener({...event,metaKey:true});listener({...event,button:2});listener({...event,target:{closest:()=>({querySelector:()=>null})}})
 assert.equal(count,2);stop();assert.ok(removed)
})
test('dialogue keeps complete pairs and preserves scene boundaries and speaker order',()=>{
 const first={speaker:'1',text:'谁在门外？'},reply={speaker:'2',text:'送信的。'}
 const third={speaker:'3',text:'我去开门。'},blank={speaker:'2',text:' '}
 assert.deepEqual(dialoguePairs([first,blank,first,reply]),[[first.text,reply.text]])
 assert.deepEqual(dialogueScenes([[first,blank,third],[reply],[reply,first]]),[[first,third],[reply,first]])
})
test('the bundled dialogue provides a playable conversation',()=>{
 const pairs=dialoguePairs(lines.active),scenes=dialogueScenes(lines.conversations??[])
 assert.ok(pairs.length+scenes.length>0)
})
