import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {openBook} from '../read.js'
import {VERSION,contractHash,legacyContractHash,supportedContracts,canonical,digest,validateRecord,verifyGraph,verifyEvidence,references,sourceState} from './validate.js'
import {sourceLocations,presentStoryRecords,sortStoryRecords,validatePresentationOptions} from './presentation.js'
import catalog from './catalog.json' with {type:'json'}

const ddl=readFileSync(new URL('./schema.sql',import.meta.url),'utf8')
const stamp=()=>new Date().toISOString()
function id(value){if(typeof value!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/u.test(value))throw Error('无效操作／运行标识');return value}
function exists(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_story_data_meta'").get()}
function ready(db,write=false,legacyWrite=false){
  if(!exists(db)){if(!write)return false;db.exec(ddl);for(const [k,v] of Object.entries({version:VERSION,contract_hash:contractHash}))db.prepare('INSERT INTO lg_story_data_meta VALUES (?,?)').run(k,v)}
  const meta=Object.fromEntries(db.prepare('SELECT * FROM lg_story_data_meta').all().map(r=>[r.key,r.value]))
  if(supportedContracts[meta.version]!==meta.contract_hash)throw Error('故事数据契约版本不匹配；需要显式迁移，未覆盖旧数据')
  if(write&&!legacyWrite&&meta.version!==VERSION)throw Error('写入新版故事资料前需预览并迁移旧契约；历史读取仍可使用')
  return true
}
function heads(db){return db.prepare('SELECT r.*,v.* FROM lg_story_data_records r JOIN lg_story_data_revisions v ON v.id=r.head').all().map(row=>({...row,record:JSON.parse(row.payload_json),dependencies:JSON.parse(row.dependencies_json)}))}
function dependencyCurrent(db,row,hash){
 if(!row)return false
 if(row.digest===hash&&!['rejected','withdrawn'].includes(row.approval))return true
 return !!row.confirmed_head&&db.prepare('SELECT digest FROM lg_story_data_revisions WHERE id=?').get(row.confirmed_head)?.digest===hash
}
function coverage(db,entries){
  if(!Array.isArray(entries)||entries.length>2000)throw Error('必须声明有限的正文覆盖范围')
  const seen=new Set()
  for(const s of entries){
    if(!Number.isSafeInteger(s.document_id)||!Number.isSafeInteger(s.version_id)||!['complete','partial','missing'].includes(s.status)||typeof s.note!=='string')throw Error('覆盖范围格式错误')
    if(seen.has(s.document_id))throw Error('覆盖范围重复');seen.add(s.document_id)
    const row=db.prepare('SELECT v.content,v.document_id,d.active_version_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?').get(s.version_id)
    if(!row||row.document_id!==s.document_id||row.active_version_id!==s.version_id||digest(row.content)!==s.sha256)throw Error('覆盖来源已变化')
    if(s.status==='missing'&&row.content.trim())throw Error('有正文不能标为缺失')
  }
}
export function importStoryData(directory,input){
 const book=openBook(directory,{write:true})
 try{
  if(input?.schema!=='lg.story-data.batch.v1'||![contractHash,legacyContractHash].includes(input.contract_hash)||input.book_id!==book.project.project_id||input.branch!=='main')throw Error('导入契约、作品或分支不匹配')
  id(input.operation);id(input.run?.id)
  if(!['model','author'].includes(input.run.producer)||typeof input.run.method!=='string'||!input.run.method||!Array.isArray(input.records)||!input.records.length||input.records.length>1500)throw Error('运行来源或记录数量无效')
  if(Buffer.byteLength(JSON.stringify(input))>8_000_000)throw Error('单次导入超过 8 MB')
  ready(book.db,true,input.contract_hash===legacyContractHash)
  const fingerprint=digest(input),prior=book.db.prepare('SELECT * FROM lg_story_data_operations WHERE id=?').get(input.operation)
  if(prior){if(prior.fingerprint!==fingerprint)throw Error('操作 ID 已用于不同内容');return JSON.parse(prior.receipt_json)}
  coverage(book.db,input.coverage)
  if(input.run.producer==='model'&&!input.coverage.length)throw Error('模型提取必须声明阅读范围')
  const old=heads(book.db),byId=new Map(old.map(r=>[r.record.id,r])),next=new Map(old.map(r=>[r.record.id,r.record])),ids=new Set(),planned=new Map()
  for(const item of input.records){
   const r=validateRecord(item.record),previous=byId.get(r.id)
   if(input.contract_hash===legacyContractHash&&r.schema_version!=='1.0.0')throw Error('旧契约批次不能含新版记录')
   if(ids.has(r.id))throw Error('同一批不能重复提交记录 ID');ids.add(r.id)
   if((item.expected_revision??null)!==(previous?.head??null))throw Error('记录版本已变化：'+r.id)
   if(previous&&previous.type!==r.type)throw Error('记录类型不能改变')
   if(input.run.producer==='model'&&r.basis==='author')throw Error('模型不能冒充作者设定')
   for(const e of r.evidence)if(!input.coverage.some(s=>s.document_id===e.document_id&&s.version_id===e.version_id&&s.sha256===e.sha256&&s.status!=='missing'))throw Error('证据超出本次声明的阅读范围')
   verifyEvidence(book.db,r);next.set(r.id,r);planned.set(r.id,randomUUID())
  }
  verifyGraph([...next.values()])
  const runHash=digest({run:input.run,coverage:input.coverage}),run=book.db.prepare('SELECT fingerprint FROM lg_story_data_runs WHERE id=?').get(input.run.id)
  if(run&&run.fingerprint!==runHash)throw Error('运行 ID 已绑定其他来源')
  if(!run)book.db.prepare('INSERT INTO lg_story_data_runs VALUES (?,?,?,?,?)').run(input.run.id,runHash,canonical(input.run),canonical(input.coverage),stamp())
  for(const {record:r} of input.records)if(!byId.has(r.id))book.db.prepare('INSERT INTO lg_story_data_records VALUES (?,?,?,?,NULL)').run(r.id,r.type,'main',planned.get(r.id))
  const receipt={operation:input.operation,run:input.run.id,count:input.records.length,revisions:{}}
  for(const {record:r} of input.records){
   const rev=planned.get(r.id),dependencies=Object.fromEntries(references(r).filter(([target])=>target!==r.id).map(([target])=>[target,digest(next.get(target))]))
   book.db.prepare('INSERT INTO lg_story_data_revisions VALUES (?,?,?,?,?,?,?,?,?)').run(rev,r.id,byId.get(r.id)?.head??null,input.run.id,'candidate',canonical(r),canonical(dependencies),digest(r),stamp())
   book.db.prepare('UPDATE lg_story_data_records SET head=? WHERE id=?').run(rev,r.id);receipt.revisions[r.id]=rev
  }
  book.db.prepare('INSERT INTO lg_story_data_operations VALUES (?,?,?,?)').run(input.operation,fingerprint,canonical(receipt),stamp())
  book.verify();book.db.exec('COMMIT');return receipt
 }finally{book.close()}
}
export function decideStoryRecord(directory,input){
 const book=openBook(directory,{write:true})
 try{
  if(!ready(book.db))throw Error('尚无故事数据')
  if(input.book_id!==book.project.project_id||!['confirmed','rejected','withdrawn'].includes(input.approval)||typeof input.reason!=='string'||!input.reason.trim()||typeof input.author!=='string'||!input.author.trim())throw Error('需要明确作者、理由、作品与处理状态')
  id(input.operation)
  const hash=digest(input),prior=book.db.prepare('SELECT * FROM lg_story_data_operations WHERE id=?').get(input.operation)
  if(prior){if(prior.fingerprint!==hash)throw Error('操作 ID 冲突');return JSON.parse(prior.receipt_json)}
  const current=heads(book.db).find(r=>r.record.id===input.id)
  if(!current||current.head!==input.expected_revision)throw Error('记录已变化')
  if(input.approval==='confirmed'){
   verifyEvidence(book.db,current.record)
   const all=new Map(heads(book.db).map(r=>[r.record.id,r]))
   if(Object.entries(current.dependencies).some(([id,hash])=>!dependencyCurrent(book.db,all.get(id),hash)))throw Error('关联依据版本已变化，请先修订记录')
  }
  const revision=randomUUID(),run='author:'+randomUUID()
  book.db.prepare('INSERT INTO lg_story_data_runs VALUES (?,?,?,?,?)').run(run,hash,canonical({id:run,producer:'author',author:input.author,reason:input.reason}),'[]',stamp())
  book.db.prepare('INSERT INTO lg_story_data_revisions VALUES (?,?,?,?,?,?,?,?,?)').run(revision,input.id,current.head,run,input.approval,current.payload_json,current.dependencies_json,current.digest,stamp())
  book.db.prepare('UPDATE lg_story_data_records SET head=? WHERE id=?').run(revision,input.id)
  if(input.approval==='confirmed')book.db.prepare('UPDATE lg_story_data_records SET confirmed_head=? WHERE id=?').run(revision,input.id)
  if(input.approval==='withdrawn')book.db.prepare('UPDATE lg_story_data_records SET confirmed_head=NULL WHERE id=?').run(input.id)
  const receipt={id:input.id,revision,approval:input.approval}
  book.db.prepare('INSERT INTO lg_story_data_operations VALUES (?,?,?,?)').run(input.operation,hash,canonical(receipt),stamp())
  book.verify();book.db.exec('COMMIT');return receipt
 }finally{book.close()}
}
export function readStoryData(directory,options={},snapshot=null){
 const book=snapshot??openBook(directory)
 try{
  const chapters=book.db.prepare("SELECT id,title,sequence,active_version_id FROM documents WHERE kind='chapter' AND state NOT IN ('archived','rejected') ORDER BY sequence,id").all()
  const empty={contract:VERSION,contract_hash:contractHash,book_id:book.project.project_id,catalog,chapters:['reader','character'].includes(options.audience)?chapters.slice(0,options.through_chapter):chapters,counts:{},records:[],total:0,runs:[]}
  const limit=options.limit??50,offset=options.offset??0
  validatePresentationOptions(options)
  if(options.confirmed_only!==undefined&&typeof options.confirmed_only!=='boolean')throw Error('确认筛选参数无效')
  const onlyConfirmed=options.confirmed_only||['reader','character'].includes(options.audience)
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)throw Error('分页范围无效')
  if(options.type&&!catalog[options.type])throw Error('未知故事数据类别')
  if(options.through_chapter!==undefined&&(!Number.isSafeInteger(options.through_chapter)||options.through_chapter<1||options.through_chapter>chapters.length))throw Error('阅读位置无效')
  if(options.audience&&!['author','reader','character'].includes(options.audience))throw Error('未知阅读视图')
  if(options.audience==='character'&&!options.holder)throw Error('人物视图需要持有人')
  if(['character','reader'].includes(options.audience)&&!options.through_chapter)throw Error('受限视图需要正文范围')
  if(!ready(book.db))return empty
  const documents=book.db.prepare('SELECT id,title,kind,parent_id,sequence FROM documents').all()
  const locations=sourceLocations(documents,chapters)
  const positions=new Map([...locations].map(([id,location])=>[id,location?.chapter])),cache=new Map(),all=heads(book.db),headsById=new Map(all.map(r=>[r.record.id,r]))
  const state=s=>{const key=canonical(s);if(!cache.has(key))cache.set(key,sourceState(book.db,s));return cache.get(key)}
  let rows=all.map(row=>{
   const confirmed=row.confirmed_head
   if(onlyConfirmed)row=confirmed?book.db.prepare('SELECT * FROM lg_story_data_revisions WHERE id=?').get(confirmed):null
   if(!row)return null
   if(options.through_chapter){
    // Follow the revision chain rather than pretending the latest profile existed in earlier chapters.
    while(row&&(JSON.parse(row.payload_json).evidence.some(e=>(positions.get(e.document_id)??Infinity)>options.through_chapter)||(onlyConfirmed&&row.approval!=='confirmed')))row=row.previous_id?book.db.prepare('SELECT * FROM lg_story_data_revisions WHERE id=?').get(row.previous_id):null
   }
   if(!row)return null
   const record=JSON.parse(row.payload_json),deps=JSON.parse(row.dependencies_json),states=record.evidence.map(state)
   const freshness=states.includes('invalid')?'invalid':states.includes('unavailable')?'unavailable':states.includes('stale')?'stale':'current'
   const related_changed=Object.entries(deps).filter(([id,hash])=>!dependencyCurrent(book.db,headsById.get(id),hash)).map(([id])=>id)
   return {...record,revision:row.id,confirmed_revision:confirmed,approval:row.approval,freshness,related_changed,created_at:row.created_at,run_id:row.run_id}
  }).filter(Boolean)
  if(options.audience==='reader')rows=rows.filter(r=>r.type==='revelation'&&r.approval==='confirmed'&&r.freshness==='current'&&!r.related_changed.length)
  if(options.audience==='character')rows=rows.filter(r=>r.type==='knowledge'&&r.payload.holder===options.holder&&r.approval==='confirmed'&&r.freshness==='current'&&!r.related_changed.length)
  // These are evidence-bounded histories, not a claim of complete knowledge or automatic story-time resolution.
  const counts={};for(const r of rows)counts[r.type]=(counts[r.type]??0)+1
  rows=presentStoryRecords(rows,locations)
  const directory=Object.fromEntries(rows.map(r=>[r.id,{title:r.display.title,type:r.type}]))
  const entities=sortStoryRecords(rows.filter(r=>r.type==='entity'),'recommended','entity').map(r=>({id:r.id,name:r.display.title,kind:r.payload.entity_kind}))
  if(options.type)rows=rows.filter(r=>r.type===options.type)
  if(options.entity_kind)rows=rows.filter(r=>r.payload.entity_kind===options.entity_kind)
  if(options.dimension)rows=rows.filter(r=>r.payload.dimension===options.dimension)
  if(options.thread_kind)rows=rows.filter(r=>r.payload.thread_kind===options.thread_kind)
  if(options.reader_visibility)rows=rows.filter(r=>r.display.reader_visibility?.state===options.reader_visibility)
  if(options.id)rows=rows.filter(r=>r.id===options.id)
  if(options.subject)rows=rows.filter(r=>r.id===options.subject||references(r).some(([id])=>id===options.subject))
  if(options.query){const q=String(options.query).toLocaleLowerCase().slice(0,200);rows=rows.filter(r=>[r.id,r.title,r.summary,JSON.stringify(r.payload)].join(' ').toLocaleLowerCase().includes(q))}
  rows=sortStoryRecords(rows,options.sort,options.type)
  const pageOffset=rows.length?Math.min(offset,Math.floor((rows.length-1)/limit)*limit):0
  const runs=options.audience&&options.audience!=='author'?[]:book.db.prepare('SELECT * FROM lg_story_data_runs ORDER BY created_at DESC LIMIT 100').all().map(r=>({id:r.id,metadata:JSON.parse(r.metadata_json),coverage:JSON.parse(r.coverage_json),created_at:r.created_at}))
  book.verify();return {...empty,counts,directory,entities,records:rows.slice(pageOffset,pageOffset+limit),total:rows.length,offset:pageOffset,limit,runs,sort:options.sort??'recommended',view:options.audience??'author',coverage_notice:'只表示已登记证据，不代表完整认知。故事时间按原记录展示；倒叙与不确定区间不自动归并。'}
 }finally{if(!snapshot)book.close()}
}
export function storyRecordHistory(directory,recordId){const book=openBook(directory);try{return ready(book.db)?book.db.prepare('SELECT * FROM lg_story_data_revisions WHERE record_id=? ORDER BY rowid').all(recordId).map(r=>({revision:r.id,previous:r.previous_id,approval:r.approval,created_at:r.created_at,record:JSON.parse(r.payload_json)})):[]}finally{book.close()}}

function migrationSnapshot(book){
 const db=book.db
 if(!ready(db))return {from_version:null,to_version:VERSION,needed:false,records:0,issues:[],token:digest({book:book.project.project_id,empty:true})}
 const meta=Object.fromEntries(db.prepare('SELECT * FROM lg_story_data_meta ORDER BY key').all().map(r=>[r.key,r.value]))
 const rows=heads(db),issues=[]
 try{for(const r of rows)validateRecord(r.record);verifyGraph(rows.map(r=>r.record))}catch(error){issues.push(error.message)}
 const tables={}
 for(const name of ['lg_story_data_records','lg_story_data_revisions','lg_story_data_runs']){
  const data=db.prepare('SELECT * FROM '+name+' ORDER BY id LIMIT 100001').all()
  if(data.length>100000)throw Error('迁移超过单次记录上限')
  tables[name]=data
 }
 const sources=db.prepare('SELECT d.id,d.active_version_id,v.content FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id ORDER BY d.id').all().map(r=>[r.id,r.active_version_id,digest(r.content??'')])
 return {from_version:meta.version,to_version:VERSION,needed:meta.version!==VERSION,records:rows.length,issues,
  token:digest({book:book.project.project_id,meta,tables,sources})}
}
export function previewStoryMigration(directory){const book=openBook(directory);try{const p=migrationSnapshot(book);book.verify();return p}finally{book.close()}}
export function migrateStoryData(directory,input){
 const book=openBook(directory,{write:true})
 try{
  id(input?.operation)
  if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/u.test(input.token))throw Error('迁移需要有效预览 token')
  const fingerprint=digest({kind:'story-time-migration',token:input.token})
  if(exists(book.db)){
   const prior=book.db.prepare('SELECT * FROM lg_story_data_operations WHERE id=?').get(input.operation)
   if(prior){if(prior.fingerprint!==fingerprint)throw Error('迁移操作 ID 冲突');return JSON.parse(prior.receipt_json)}
  }
  const preview=migrationSnapshot(book)
  if(preview.token!==input.token)throw Error('迁移依据已经变化，请重新预览')
  if(preview.issues.length)throw Error('迁移前需修复已有约束：'+preview.issues.join('；'))
  const result={from_version:preview.from_version,to_version:VERSION,records:preview.records,operation:input.operation,changed:preview.needed}
  if(preview.needed){
   book.db.prepare('UPDATE lg_story_data_meta SET value=? WHERE key=?').run(VERSION,'version')
   book.db.prepare('UPDATE lg_story_data_meta SET value=? WHERE key=?').run(contractHash,'contract_hash')
   book.db.prepare('INSERT INTO lg_story_data_operations VALUES (?,?,?,?)').run(input.operation,fingerprint,canonical(result),stamp())
  }
  book.verify();book.db.exec('COMMIT');return result
 }finally{book.close()}
}
