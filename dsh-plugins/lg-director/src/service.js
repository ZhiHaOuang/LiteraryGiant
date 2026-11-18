import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { relative,isAbsolute } from 'node:path'
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity=id=>{if(typeof id!=='string'||! /^[\w-]{16,50}$/u.test(id))throw new Error('任务标识无效。');return id}
const operation=id=>'director-'+identity(id)
const exists=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_director_tasks'").get()
function findTask(db,id) {
  const row=exists(db)&&db.prepare('SELECT state FROM lg_director_tasks WHERE id=?').get(identity(id))
  return row?JSON.parse(row.state):null
}
const load=(db,id)=>{const task=findTask(db,id);if(!task)throw new Error('分派任务不存在。');return task}
const expose=s=>({...s,token:hash(s)})
function save(db,s){
  s.updatedAt=new Date().toISOString();const value=JSON.stringify(s)
  if(value.length>2000000)throw new Error('交接记录过大；请检查原调用记录。')
  db.exec('CREATE TABLE IF NOT EXISTS lg_director_tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL)')
  db.prepare('INSERT INTO lg_director_tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(s.id,value)
  return expose(s)
}
const fields=['task','role','request','document','version','token','start','end','target','context','references','feedback','requirements','category','method']
export const tasks={polish:'精确选区润色候选',review:'临时原文证据审阅','manuscript-review':'保存正文审阅报告','plan-review':'保存规划审阅报告',ideas:'三个待选创作方向','scene-plan':'待批准场景计划','draft-scene':'按批准计划起草空场景候选','draft-chapter':'当前章节完整正文候选','extract-memory':'已采纳正文的待审事实','analyze-reference':'选定资料的待审方法卡','candidate-analysis':'生成本书要求的一类候选监督报告'}
export function createDirector(books,agents){
  const active=new Map(),lifetime=new AbortController(),key=(path,id)=>hash({path,id})
  const read=(path,id)=>books.readState(path,db=>load(db,id))
  const change=(path,id,fn)=>books.changeState(path,db=>{const s=load(db,id),before=JSON.stringify(s);fn(s);return before===JSON.stringify(s)?expose(s):save(db,s)})
  const prepare=(path,s)=>{
    const plan=agents.preview({...s.input,path})
    if(plan.signature!==s.signature)throw new Error('任务正文、资料、偏好或模型设置已变化，请重新提议。')
    return {plan,token:hash({state:s,signature:plan.signature})}
  }
  const execute=async(path,id,signal)=>{
    const s=read(path,id)
    try{
      const result=await agents.run({...s.input,path,operation:operation(id),signature:s.signature},AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]))
      return change(path,id,value=>{value.result=result;value.status=value.stopRequested?'stopped':result.status.endsWith('-ready')?'completed':'stopped'})
    }catch(error){return change(path,id,value=>{value.status='stopped';value.reason=error.message})}
  }
  const tracked=(path,id,fn)=>{
    const k=key(path,id);if(active.has(k))return active.get(k)
    const pending=Promise.resolve().then(fn);active.set(k,pending);const done=()=>active.delete(k);pending.then(done,done);return pending
  }
  return {
    catalog:()=>Object.entries(tasks).flatMap(([task,description])=>{
      const roles=agents.roles().filter(role=>role.enabled&&role.tasks.includes(task)).map(role=>({id:role.id,name:role.name}))
      return roles.length?[{task,description,roles}]:[]
    }),
    forDirectory(directory){
      const cwd=realpathSync(directory),matches=books.list().filter(b=>!b.error).map(b=>({path:b.path,root:realpathSync(b.path)})).filter(b=>{const r=relative(b.root,cwd);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('../')})
      if(!matches.length)throw new Error('当前工作目录不属于已登记作品。')
      return matches.sort((a,b)=>b.root.length-a.root.length)[0].path
    },
    supervision(path,document,version){
      if(!Number.isSafeInteger(version)||version<1)throw new Error('请选择候选版本 ID。')
      if(!agents.analysisStatus)throw new Error('请启用支持候选监督的文学专家。')
      const body=books.manuscript(path,document,version)
      if(body.selected.state!=='candidate')throw new Error('请选择待审候选版本。')
      const target={document:body.document.id,version:body.selected.id,token:body.token}
      return {target,...agents.analysisStatus(path,target)}
    },
    source(path,id,version,start=0,end){
      const body=books.manuscript(path,id,version),content=body.selected.content;end??=Math.min(content.length,start+4000)
      const splits=i=>i>0&&i<content.length&&/[\uD800-\uDBFF]/u.test(content[i-1])&&/[\uDC00-\uDFFF]/u.test(content[i])
      if(splits(start)||splits(end)||![start,end].every(Number.isSafeInteger)||start<0||end<start||end>content.length||end-start>12000)throw new Error('每次只读取明确的 0–12000 字符范围。')
      const {content:activeContent,...document}=body.document
      return {document,version:body.selected.id,state:body.selected.state,token:body.token,length:content.length,start,end,text:content.slice(start,end),truncated:start!==0||end!==content.length,versions:body.versions.slice(0,20),parts:body.parts}
    },
    propose(path,input,id,origin=null){
      identity(id)
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))||!Object.hasOwn(tasks,input.task)||JSON.stringify(input).length>32000)throw new Error('只能提议已支持的有界文学任务；不得指定路径、操作编号或正式采用。')
      if(origin!==null&&(typeof origin!=='string'||origin.length>200))throw new Error('来源会话标识无效。')
      const requestHash=hash({input,origin})
      function replay(db){
        const old=findTask(db,id)
        if(old&&old.requestHash!==requestHash)throw new Error('同一分派标识不能更换任务。')
        return old&&expose(old)
      }
      const old=books.readState(path,replay)
      if(old)return old
      // A candidate projection needs its own rolled-back SQLite transaction.
      const plan=agents.preview({...input,path})
      return books.changeState(path,db=>{
        return replay(db)??save(db,{id,input:structuredClone(input),origin,signature:plan.signature,requestHash,status:'proposed',createdAt:new Date().toISOString()})
      })
    },
    read(path,id){
      const state={...expose(read(path,id)),locallyRunning:active.has(key(path,id))}
      try{state.call=agents.status(operation(id))}catch(error){state.callError=error.message}
      return state
    },
    list(path,offset=0){
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('分页无效。')
      return books.readState(path,db=>{if(!exists(db))return {items:[],nextOffset:null};const rows=db.prepare('SELECT state FROM lg_director_tasks ORDER BY rowid DESC LIMIT 21 OFFSET ?').all(offset)
        return {items:rows.slice(0,20).map(r=>{const s=JSON.parse(r.state);return {id:s.id,task:s.input.task,request:s.input.request,status:s.status,origin:s.origin,createdAt:s.createdAt}}),nextOffset:rows.length>20?offset+20:null}})
    },
    preview(path,id){const s=read(path,id);if(s.status!=='proposed')throw new Error('此任务已开始或已处理，请查看原结果。');return prepare(path,s)},
    run(path,id,token,signal){
      if(lifetime.signal.aborted)throw new Error('分派插件已停用。')
      return tracked(path,id,async()=>{
        const before=read(path,id)
        if(before.status!=='proposed')return expose(before)
        if(prepare(path,before).token!==token)throw new Error('分派预览已变化。')
        let start=false
        const state=change(path,id,s=>{if(s.status!=='proposed')return;if(hash(s)!==hash(before))throw new Error('分派预览已变化。');s.status='running';start=true})
        return start?execute(path,id,signal):state
      })
    },
    recover(path,id,signal){
      if(lifetime.signal.aborted)throw new Error('分派插件已停用。')
      return tracked(path,id,()=>{
        const s=read(path,id)
        if(!['running','stopped'].includes(s.status)||s.result?.status.endsWith('-ready'))return expose(s)
        const call=agents.status(operation(id))
        if(call?.status!=='succeeded')return {...expose(s),recoveryMessage:'原调用没有确定成功结果；只供检查，不重新收费执行。'}
        return execute(path,id,signal)
      })
    },
    stop(path,id,token,reason){
      if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('请填写停止或驳回理由。')
      const state=change(path,id,s=>{if(hash(s)!==token)throw new Error('分派状态已变化。');if(s.status==='completed')throw new Error('结果已保存，请在对应文学面板处理。');s.status=s.status==='proposed'?'dismissed':'stopped';s.stopRequested=true;s.reason=reason})
      if(state.status==='stopped')agents.cancel(operation(id))
      return state
    },
    async dispose(){lifetime.abort();await Promise.allSettled([...active.values()])},
  }
}
