import {constants,lstatSync,readdirSync} from 'node:fs'
import {open} from 'node:fs/promises'
import {dirname} from 'node:path'
import {openBook} from './read.js'
import {chapterPath,readText,hash} from './chapter-file-format.js'
import {compactFingerprint,parseReportIdentity} from './analysis-snapshot.js'

const localId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(id)
const publicEvents=new Set(['run.started','run.resumed','run.planned','run.completed','run.failed','context.started','context.completed','stage.started','stage.completed','stage.failed','artifact.written'])
const file=(root,id,name)=>chapterPath(root,['.literarygiant','runs',id],name)
function parse(raw,label,reader=JSON.parse){
  try{return reader(raw)}catch{throw new Error(label+'含有无法核对的 JSON。')}
}
function manifest(root,id) {
  if(!localId(id))throw new Error('旧运行编号无效。')
  const raw=readText(file(root,id,'run.json'),4_000_000)
  if(raw===null)throw new Error('未找到旧运行清单。')
  const value=parse(raw,'旧运行清单')
  if(value.schema_version!=='lg.run.v2'||value.run_id!==id||
    ['workflow','status','request','created_at','updated_at'].some(k=>typeof value[k]!=='string')||
    ['provider','model'].some(k=>value[k]!=null&&typeof value[k]!=='string')||
    !Array.isArray(value.completed_stages)||value.completed_stages.some(s=>typeof s!=='string'))throw new Error('旧运行清单的格式或身份无效。')
  return value
}
function summary(m){
  return {id:m.run_id,workflow:m.workflow,status:m.status,updated:m.updated_at,title:m.request.slice(0,240).replace(/\s+/gu,' ').trim().slice(0,60)}
}
export function oldRuns(path,before){
  const book=openBook(path)
  try{
    if(before!=null&&!localId(before))throw new Error('旧运行分页位置无效。')
    const directory=dirname(chapterPath(book.root,['.literarygiant','runs'],'run.json'))
    let entries
    try{entries=readdirSync(directory,{withFileTypes:true})}catch(error){if(error.code!=='ENOENT')throw error;return {items:[],next:null}}
    const ids=entries.filter(e=>e.isDirectory()&&localId(e.name)&&(!before||e.name<before)).map(e=>e.name).sort().reverse()
    const items=ids.slice(0,20).map(id=>{try{return summary(manifest(book.root,id))}catch{return {id,error:'旧运行清单无法读取。'}}})
    book.verify();return {items,next:ids.length>20?items.at(-1).id:null}
  }finally{book.close()}
}
function stamp(path){
  const stat=lstatSync(path,{bigint:true,throwIfNoEntry:false})
  return stat?[stat.dev,stat.ino,stat.size,stat.ctimeNs].join('/'):null
}
async function publicHistory(path,id,workflow){
  const events=[],decoder=new TextDecoder('utf-8',{fatal:true})
  let total=0,pending=Buffer.alloc(0),handle
  function processLine(line){
    if(!line.trim())return
    const e=parse(line,'旧事件')
    if(e?.run_id!==id||e.workflow!==workflow)throw new Error('旧事件与运行不匹配。')
    if(!publicEvents.has(e.type))return
    if(!Number.isSafeInteger(e.sequence)||typeof e.timestamp!=='string'||typeof e.message!=='string'||
        (e.stage_id!=null&&typeof e.stage_id!=='string'))throw new Error('旧事件格式无效。')
    const event={sequence:e.sequence,type:e.type,at:e.timestamp,stage:e.stage_id??null,message:e.type.endsWith('.failed')?'执行失败，详见旧运行诊断。':e.message}
    total+=Buffer.byteLength(JSON.stringify(event))
    if(total>4_000_000)throw new Error('公开历史超过单次导入上限。')
    events.push(event)
  }
  try{
    try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch(e){if(e.code==='ENOENT')return events;throw e}
    const stat=await handle.stat()
    if(!stat.isFile()||stat.nlink!==1)throw new Error('旧事件文件类型无效。')
    for await(const chunk of handle.createReadStream()){
      const bytes=pending.length?Buffer.concat([pending,chunk]):chunk
      let start=0,end
      while((end=bytes.indexOf(10,start))!==-1){
        if(end-start>4*1024*1024)throw new Error('旧事件单条记录超过上限。')
        processLine(decoder.decode(bytes.subarray(start,end)));start=end+1
      }
      pending=bytes.subarray(start)
      if(pending.length>4*1024*1024)throw new Error('旧事件单条记录超过上限。')
    }
    if(pending.length)processLine(decoder.decode(pending))
    return events
  }finally{await handle?.close()}
}
function literaryTask(raw,m){
  if(raw===null){if(m.literary_task_policy)throw new Error('文学任务状态缺失。');return null}
  const typed=parse(raw,'旧文学任务',parseReportIdentity),digest=typed?.fingerprint
  if(!typed||typeof typed!=='object'||Array.isArray(typed))throw new Error('文学任务状态无效。')
  delete typed.fingerprint
  if(typed.schema!=='lg.literary-task.v1'||typed.runId!==m.run_id||compactFingerprint(typed)!==digest)throw new Error('文学任务身份或指纹不匹配。')
  const task=JSON.parse(raw)
  if(task.status!==m.status)throw new Error('文学任务与运行清单状态不同步。')
  if(['strategy','reason','stageRunId'].some(k=>task[k]!=null&&typeof task[k]!=='string')||
     task.modelCalls!=null&&(!Number.isSafeInteger(task.modelCalls)||task.modelCalls<0))throw new Error('文学任务摘要无效。')
  return task
}
function versionProof(db,ref){
  const row=db.prepare(`SELECT v.content,v.metadata_json,d.metadata_json AS docmeta FROM document_versions v
    JOIN documents d ON v.document_id=d.id WHERE d.id=? AND d.slug=? AND v.id=? AND v.version_number=? AND d.kind IN ('chapter','scene')`)
    .get(ref.document,ref.slug,ref.version,ref.number)
  if(!row)return null
  const linked=parse(row.metadata_json??'{}','正文版本信息')?.run_id===ref.owner||
    ref.number===1&&parse(row.docmeta??'{}','文档信息')?.run_id===ref.owner
  return linked?hash(row.content):null
}
export function verifyOldVersion(db,ref){
  if(!ref.sha256||versionProof(db,ref)!==ref.sha256)throw new Error('历史正文版本已变化或无法在本书中核对。')
  return {document:ref.document,version:ref.version}
}
export async function legacyRun(path,id){
  if(!localId(id))throw new Error('旧运行编号无效。')
  const initial=openBook(path),root=initial.root,project=initial.project.project_id
  initial.close()
  const files=['run.json','events.jsonl','literary-task.json'].map(n=>file(root,id,n)),before=files.map(stamp)
  const m=manifest(root,id),events=await publicHistory(files[1],id,m.workflow),t=literaryTask(readText(files[2],4_000_000),m)
  const book=openBook(path)
  try {
    if(book.root!==root||book.project.project_id!==project)throw new Error('作品在读取期间发生变化。')
    const record={...summary(m),project:book.project.project_id,request:m.request,created:m.created_at,provider:m.provider??null,model:m.model??null,
      resumedFrom:localId(m.resumed_from)?m.resumed_from:null,stages:m.completed_stages,events,
      reason:t?.reason??(m.error?'run_failed':null),strategy:t?.strategy??null,modelCalls:t?.modelCalls??null}
    if(t?.decision){
      const {options,optionsVersionNumber,optionsVersion,slug}=t.decision
      if(typeof slug!=='string'||!Array.isArray(options)||options.length!==3||
        options.some(o=>['id','title','summary'].some(k=>typeof o?.[k]!=='string')))throw new Error('旧方向方案的历史摘要无效。')
      record.decision={slug,number:optionsVersionNumber??optionsVersion,options:options.map(({id,title,summary})=>({id,title,summary}))}
    }
    // Keep only manuscript versions with an explicit run link in this book.
    const refs=book.db.prepare(`SELECT d.id AS document,d.slug,v.id AS version,v.version_number AS number
      FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.kind IN ('chapter','scene') AND
      (CASE WHEN json_valid(v.metadata_json) THEN json_extract(v.metadata_json,'$.run_id') END=?
       OR (v.version_number=1 AND CASE WHEN json_valid(d.metadata_json) THEN json_extract(d.metadata_json,'$.run_id') END=?))
      ORDER BY v.id`).all(id,id)
    for(const row of refs)row.owner=id
    if(t?.candidate){
      const c=t.candidate,owner=t.stageRunId??id
      const row=book.db.prepare(`SELECT d.id AS document,d.slug,v.id AS version,v.version_number AS number FROM document_versions v
        JOIN documents d ON d.id=v.document_id WHERE v.id=? AND d.slug=? AND d.kind IN ('chapter','scene') AND v.version_number=?
        AND json_extract(v.metadata_json,'$.run_id')=?`).get(c.versionId,c.document,c.versionNumber,owner)
      if(row&&!refs.some(ref=>ref.version===row.version))refs.push({...row,owner})
      if(!row)record.candidateUnavailable=true
    }
    record.versions=refs.map(ref=>({...ref,sha256:versionProof(book.db,ref)}))
    if(JSON.stringify(before)!==JSON.stringify(['run.json','events.jsonl','literary-task.json'].map(n=>stamp(file(root,id,n)))))throw new Error('旧运行在读取期间发生变化，请刷新。')
    book.verify()
    const json=JSON.stringify(record)
    if(Buffer.byteLength(json)>4_000_000)throw new Error('公开历史超过单次导入上限。')
    return {record,token:hash(json)}
  }finally{book.close()}
}
