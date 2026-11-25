import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { reviewNotes } from '../src/review-notes.js'
import { paragraphs } from '../src/review-text.js'

const source = '潮汐😀\r\n\n海风停了。'
const id='8b05e654-6fa1-4545-a116-408bece3201c'
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY,kind TEXT);
    CREATE TABLE document_versions(id INTEGER PRIMARY KEY,document_id INTEGER,content TEXT);
    INSERT INTO documents VALUES(1,'chapter'),(2,'chapter')`)
  for (const [v,d] of [[10,1],[11,1],[12,2]]) db.prepare('INSERT INTO document_versions VALUES(?,?,?)').run(v,d,source)
  const access = (_path, fn) => fn(db)
  const input = { path:'/fixture',document:1,version:10,id, start:2,end:8,quote:source.slice(2,8),note:'保留停顿' }
  return { db, call:(action,fields) => reviewNotes({readState:access,changeState:access},{...input,action,...fields}) }
}
test('new book reads without migration; annotations persist on their exact version', t => {
  const {db,call} = fixture(t)
  assert.deepEqual(call('list'),[])
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_reading_notes'").get(),undefined)
  const [row] = call('create')
  assert.equal(row.quote,source.slice(2,8))
  assert.deepEqual(call('create'),[row])
  assert.deepEqual(call('list',{version:11}),[])
  assert.deepEqual(call('list',{document:2,version:12}),[])
  assert.throws(() => call('create',{quote:'错误'}),/passage/)
  assert.throws(() => call('list',{document:2}),/version/)
  assert.equal(db.prepare('SELECT content FROM document_versions WHERE id=10').get().content,source)
})
test('stale edits are rejected and successful updates are safe to retry', t => {
  const {call}=fixture(t)
  call('create',{start:0,end:0,quote:''})
  const update={revision:1,note:'已复核',resolved:true}
  const revised=call('update',update)
  assert.equal(revised[0].revision,2)
  assert.deepEqual(call('update',update),revised)
  assert.throws(()=>call('update',{...update,note:'另一意见'}),/another window/)
  assert.throws(()=>call('update',{...update,version:11}),/Invalid/)
})
test('paragraph layout preserves UTF-16 source positions including CRLF, empty lines and overlapping marks',()=>{
  const notes=[[0,8,'a'],[2,9,'b']].map(([start,end,id])=>({start,end,id,quote:source.slice(start,end)}))
  const rows=paragraphs(source,notes)
  assert.deepEqual(rows.map(r=>r.start),[0,7])
  assert.deepEqual(rows.flatMap(r=>r.pieces.map(p=>[p.text,p.ids])),[
    ['潮汐',['a']],['😀',['a','b']],['海',['a','b']],['风',['b']],['停了。',[]],
  ])
  assert.deepEqual(rows.flatMap(r=>r.pieces.flatMap(p=>p.anchors)),['a','b'])
})

test('each passage gets one sticker, including adjacent, overlapping and paragraph-break notes',()=>{
  const text='甲乙\r\n\r\n丙丁'
  const ranges=[[0,7,'long'],[0,1,'short'],[1,2,'next'],[2,6,'break'],[6,8,'last']]
  const notes=ranges.map(([start,end,id])=>({id,start,end,quote:text.slice(start,end)}))
  notes.push({id:'chapter',start:0,end:0,quote:''},{id:'stale',start:0,end:1,quote:'旧'})
  const rows=paragraphs(text,notes)
  const pieces=rows.flatMap(row=>row.pieces)
  assert.deepEqual(pieces.flatMap(piece=>piece.anchors).sort(),ranges.map(r=>r[2]).sort())
  assert.deepEqual(pieces.find(piece=>piece.text==='甲').ids.sort(),['long','short'])
  assert.deepEqual(pieces.find(piece=>piece.ids.includes('break')).text,'')
  assert.deepEqual(rows.map(row=>row.pieces.map(piece=>piece.text).join('')),['甲乙','丙丁'])
})
