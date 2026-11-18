import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,symlinkSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import Ajv from 'ajv/dist/2020.js'
import schema from '../src/story-data/read-api-v1.json' with {type:'json'}
import {createStoryFixture} from './story-data-fixture.mjs'
import {readStoryPage,readStoryTimeline,readStoryOverview} from '../src/story-data/read-model.js'
import {exportStorySnapshot,readStorySnapshot} from '../src/story-data/snapshot.js'
import {importStoryData,readStoryData} from '../src/story-data/store.js'
import {contractHash} from '../src/story-data/validate.js'
const validate=new Ajv({strict:false}).compile(schema)
function fixture(){const book=realpathSync(mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-read-view-')));return {book,batch:createStoryFixture(book)}}
function amend(book,batch){const r=readStoryData(book,{limit:200}).records[0],record=structuredClone(batch.records.find(x=>x.record.id===r.id).record);record.summary+=' 更新后的候选。';return importStoryData(book,{...batch,contract_hash:contractHash,operation:'read-model-update',run:{id:'read-model-update',producer:'model',method:'合成测试'},records:[{record,expected_revision:r.revision}]})}
test('versioned pages, timeline and overview satisfy frozen read contract and share a data revision',()=>{
 const {book}=fixture(),page=readStoryPage(book,{limit:8}),second=readStoryPage(book,{limit:8,offset:8}),timeline=readStoryTimeline(book,{include_candidates:true}),overview=readStoryOverview(book)
 for(const value of [page,second,timeline,overview])assert.ok(validate(value),JSON.stringify(validate.errors))
 assert.equal(new Set([page,second,timeline,overview].map(v=>v.data_revision)).size,1)
 assert.equal(new Set([...page.records,...second.records].map(r=>r.id)).size,page.total)
 assert.equal(overview.quality.candidate,page.total);assert.equal(overview.quality.confirmed,0)
 assert.ok(overview.coverage.registered_chapters>0)
 assert.equal(validate({...page,api_version:'lg.story-data.read.v2'}),false)
})
test('confirmed-only and reading cutoff stay distinct from complete author snapshot',()=>{
 const {book}=fixture(),full=readStoryOverview(book),confirmed=readStoryOverview(book,{confirmed_only:true,through_chapter:1})
 assert.equal(confirmed.total,0);assert.equal(confirmed.coverage.total_chapters,1);assert.ok(full.total>0)
 assert.throws(()=>readStoryOverview(book,{audience:'character'}),/仅接受/)
})
test('scene evidence contributes to its parent chapter coverage without changing reading order',()=>{
 const {book}=fixture(),db=new DatabaseSync(join(book,'.literarygiant/story.sqlite3'))
 db.prepare("UPDATE documents SET kind='scene',parent_id=1 WHERE id=3").run();db.close()
 const overview=readStoryOverview(book),records=readStoryPage(book,{limit:200}).records
 assert.deepEqual(overview.coverage.chapters.map(c=>c.id),[1,5])
 const chapterRecords=records.filter(r=>r.evidence.some(e=>e.document_id===1||e.document_id===3))
 assert.equal(overview.coverage.chapters[0].record_count,chapterRecords.length)
 assert.ok(overview.coverage.chapters[0].record_count>records.filter(r=>r.evidence.some(e=>e.document_id===1)).length)
})
test('portable snapshots round trip independently and old snapshots survive a new candidate',()=>{
 const {book,batch}=fixture(),first=exportStorySnapshot(book),loaded=readStorySnapshot(first.directory),manifest=join(first.directory,'snapshots',first.snapshot_id,'manifest.json'),before=readFileSync(manifest,'utf8')
 assert.equal(loaded.records.length,readStoryPage(book).total);assert.deepEqual(loaded.overview,JSON.parse(JSON.stringify(readStoryOverview(book))))
 assert.equal(exportStorySnapshot(book).snapshot_id,first.snapshot_id)
 const indexed=new Set(Object.values(loaded.sections).flat());assert.equal(indexed.size,loaded.records.length)
 amend(book,batch)
 assert.throws(()=>exportStorySnapshot(book,{expected_revision:first.data_revision,output:join(book,'stale-output')}),/已变化/);assert.equal(existsSync(join(book,'stale-output')),false)
 const second=exportStorySnapshot(book);assert.notEqual(second.snapshot_id,first.snapshot_id);assert.notEqual(second.data_revision,first.data_revision)
 assert.equal(readFileSync(manifest,'utf8'),before);assert.equal(readStorySnapshot(second.directory).manifest.snapshot_id,second.snapshot_id)
})
test('offline reader rejects tampering, unknown versions and symlink redirects',()=>{
 const {book}=fixture(),result=exportStorySnapshot(book),file=join(result.directory,'snapshots',result.snapshot_id,'records.json')
 writeFileSync(file,'[]\n');assert.throws(()=>readStorySnapshot(result.directory),/摘要不匹配/)
 const pointer=join(result.directory,'CURRENT.json');writeFileSync(pointer,JSON.stringify({schema:'future',snapshot:result.snapshot_id}));assert.throws(()=>readStorySnapshot(result.directory),/不支持/)
 const alias=join(book,'alias');symlinkSync(result.directory,alias,'dir');assert.throws(()=>exportStorySnapshot(book,{output:alias}),/符号链接/)
})
