// Creates only a fresh, explicitly selected synthetic test directory.
import assert from 'node:assert/strict'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {createStoryFixture} from '../../lg-books/tests/story-data-fixture.mjs'
import {importStoryData} from '../../lg-books/src/story-data/store.js'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage&&stage.includes('/LitIsLand/'))
const root=stage+'/Books/潮汐来信'
assert.ok(!existsSync(root),'Never overwrite an existing test book')
mkdirSync(stage+'/Library',{recursive:true})
const batch=createStoryFixture(root),db=new DatabaseSync(root+'/.literarygiant/story.sqlite3')
db.prepare('UPDATE documents SET sequence=2 WHERE id=3').run()
db.prepare('UPDATE documents SET sequence=3 WHERE id=5').run()
for(let n=4;n<=37;n++){
 const id=100+n
 db.prepare('INSERT INTO documents(id,kind,slug,title,state,sequence,active_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,'chapter','chapter-'+n,'第'+n+'章 合成章节','draft',n,id,'2026-11-12','2026-11-12')
 db.prepare('INSERT INTO document_versions(id,document_id,version_number,state,content,reason,created_at) VALUES (?,?,1,?,?,?,?)').run(id,id,'draft','仅用于界面验证的合成文本。','UI fixture','2026-11-12')
}
db.close()
const clone=id=>structuredClone(batch.records.find(r=>r.record.id===id).record),extra=[]
for(const [subject,prominence] of [['person:yuan','core'],['person:lin','major']]){
 const r=clone(subject);Object.assign(r,{id:'role:'+subject,schema_version:'1.1.0',type:'role_assignment',title:'人物评级',story_time:{kind:'all',label:'全书',after_event:null,before_event:null},payload:{subject,prominence,roles:['protagonist']}});extra.push(r)
}
// Exercise two full character pages and a one-character last page.
for(let n=1;n<=11;n++){
 const r=clone('person:lin')
 r.id='person:extra-'+n;r.title='合成人物 '+n;r.links=[]
 r.payload={entity_kind:'character',name:r.title,aliases:[],description:'分页验证'}
 extra.push(r)
}
for(let n=1;n<=9;n++){const r=clone('event:injury');r.id='event:unplaced-'+n;r.title='待定位事件 '+n;r.links=[];extra.push(r)}
for(const dimension of ['summary','emotion']){const r=clone('analysis:rhythm');r.id='analysis:'+dimension;r.title=dimension==='summary'?'医馆醒来':'来信中的牵挂';r.payload.dimension=dimension;extra.push(r)}
const reveal=clone('revelation:alive');reveal.id='revelation:tide';reveal.payload.about_record='rule:tide';extra.push(reveal)
const rule=clone('rule:tide');rule.id='rule:unmarked';rule.title='尚待核对的海岛规则';extra.push(rule)
const place=clone('person:lin');place.id='place:harbor';place.title='旧码头';place.payload={entity_kind:'place',name:'旧码头',aliases:[],description:'合成测试地点。'};extra.push(place)
importStoryData(root,{...batch,operation:'dashboard-sections',run:{...batch.run,id:'dashboard-sections'},records:extra.map(record=>({record,expected_revision:null}))})
writeFileSync(stage+'/.dashboard-test-profile','Synthetic UI test only; no model calls.\n')
console.log(root)
