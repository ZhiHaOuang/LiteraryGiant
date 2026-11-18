import {summarizeRequests} from './telemetry.js'
import {usageWindow,requestTimeline} from './usage-timeline.js'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {hash,text} from './contracts.js'

const now=()=>new Date().toISOString()
const decode=row=>row?JSON.parse(row.json):null
export class TeamStore {
  constructor(directory,budgetId='default',requestLimit=100){
    // null means count-only interactive usage; bounded experiments retain strict defaults.
    if(requestLimit!==null&&(!Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>100))throw Error('请求额度须为 1—100，或 null（仅计量）')
    text(budgetId,'预算标识',100)
    mkdirSync(directory,{recursive:true,mode:0o700})
    this.db=new DatabaseSync(join(directory,'teams.sqlite3'));this.budgetId=budgetId;this.requestLimit=requestLimit
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('schema','lg.agent-teams.v1');
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,owner TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,operation TEXT NOT NULL,child TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(owner,operation));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,role TEXT NOT NULL,path TEXT NOT NULL,task TEXT);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,budget TEXT NOT NULL,session TEXT NOT NULL,role TEXT NOT NULL,path TEXT NOT NULL,task TEXT,started TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_archives(request_id TEXT PRIMARY KEY REFERENCES requests(id),reason TEXT NOT NULL,archived_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS closures(id TEXT PRIMARY KEY,at TEXT NOT NULL);`)
    this.db.exec('CREATE TABLE IF NOT EXISTS runtime_claim(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL)')
    if(this.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value!=='lg.agent-teams.v1')throw Error('不支持的任务数据库版本')
  }
  claimRuntime(){
    this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM runtime_claim WHERE id=1').get()
      if(prior){let live=true;try{process.kill(prior.pid,0)}catch(error){if(error.code==='ESRCH')live=false}if(live)throw Error('文学协作任务库已被另一个活跃宿主使用，请先退出原宿主')}
      this.runtimeToken=randomUUID();this.db.prepare('INSERT OR REPLACE INTO runtime_claim VALUES(1,?,?)').run(process.pid,this.runtimeToken)
    })
  }
  close(){
    if(this.closed)return
    if(this.runtimeToken)this.db.prepare('DELETE FROM runtime_claim WHERE id=1 AND token=?').run(this.runtimeToken)
    this.db.close();this.closed=true
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
  source(owner,value){
    const id='source-'+hash({owner,fingerprint:value.fingerprint}).slice(0,32)
    this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?)').run(id,owner,JSON.stringify(value));return id
  }
  readSource(owner,id){const row=this.db.prepare('SELECT * FROM sources WHERE id=? AND owner=?').get(id,owner);if(!row)throw Error('来源不属于当前会话');return decode(row)}
  bind(session,role,path,task=null){
    const prior=this.session(session)
    if(prior&&(prior.role!==role||prior.path!==path||prior.task!==task))throw Error('会话身份不能改变')
    this.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?,?)').run(session,role,path,task)
  }
  session(id){return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id)}
  task(id){const value=decode(this.db.prepare('SELECT json FROM tasks WHERE id=?').get(id));if(!value)throw Error('任务不存在');return value}
  taskForChild(child){return decode(this.db.prepare('SELECT json FROM tasks WHERE child=?').get(child))}
  tasks(owner){return this.db.prepare('SELECT json FROM tasks'+(owner?' WHERE owner=?':'')).all(...(owner?[owner]:[])).map(decode)}
  createTask(owner,input){
    text(input.operation,'操作标识',100);text(input.objective,'任务目标',8000)
    const fingerprint=hash(input)
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM tasks WHERE owner=? AND operation=?').get(owner,input.operation)
      if(prior){if(prior.fingerprint!==fingerprint)throw Error('操作标识已用于其他任务');return {task:decode(prior),created:false}}
      const source=this.readSource(owner,input.source_id)
      if(!Array.isArray(input.inputs)||input.inputs.length>6||new Set(input.inputs).size!==input.inputs.length)throw Error('上游任务列表无效')
      for(const id of input.inputs){const t=this.task(id);if(t.owner!==owner||t.source_id!==input.source_id||t.status!=='completed')throw Error('上游任务未完成或来源范围不同')}
      if(this.tasks(owner).filter(t=>['starting','running'].includes(t.status)).length>=3)throw Error('当前最多并行 3 名文学成员')
      const task={id:'task-'+randomUUID(),child:'lg-member-'+randomUUID(),owner,...input,path:source.path,status:'starting',created_at:now(),updated_at:now(),artifact:null,error:null}
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(task.id,owner,input.operation,task.child,fingerprint,JSON.stringify(task))
      this.bind(task.child,task.role,source.path,task.id)
      return {task,created:true}
    })
  }
  update(id,patch){const t=this.task(id);const next={...t,...patch,updated_at:now()};this.db.prepare('UPDATE tasks SET json=? WHERE id=?').run(JSON.stringify(next),id);return next}
  recover(isLive){
    for(const task of this.tasks())if(['starting','running'].includes(task.status)&&!isLive(task.child))this.update(task.id,{status:'interrupted',error:'宿主重新加载；未自动重试，可查看历史后重新委派'})
  }
  reserve(options){
    return this.transaction(()=>{
      if(this.requestLimit!==null){
        if(this.db.prepare('SELECT 1 FROM closures WHERE id=?').get(this.budgetId))throw Error('本轮模型请求额度已关闭')
        const count=this.db.prepare('SELECT count(*) AS n FROM requests WHERE budget=?').get(this.budgetId).n
        if(count>=this.requestLimit)throw Error('本轮模型请求额度已耗尽')
      }
      const identity=this.session(options.sessionId);if(!identity)throw Error('文学请求没有会话身份')
      if(this.requestLimit!==null&&identity.task&&this.db.prepare('SELECT count(*) AS n FROM requests WHERE task=? AND budget=?').get(identity.task,this.budgetId).n>=6)throw Error('单个成员最多 6 次请求，请查看失败原因后明确重派')
      const id=randomUUID(),started=now()
      const row={...identity,id,session:identity.id,budget:this.budgetId,provider:options.provider,model:options.model,purpose:options.purpose??'agent-step',started,status:'pending',usage:null}
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?)').run(id,this.budgetId,identity.id,identity.role,identity.path,identity.task,started,JSON.stringify(row))
      return row
    })
  }
  finish(id,value){const row=decode(this.db.prepare('SELECT json FROM requests WHERE id=?').get(id));if(!row||row.status!=='pending')throw Error('请求不存在或已结算');this.db.prepare('UPDATE requests SET json=? WHERE id=?').run(JSON.stringify({...row,...value,finished:now()}),id)}
  closeBudget(){
    if(this.requestLimit===null)throw Error('日常使用仅计量，没有可关闭的实验额度')
    this.db.prepare('INSERT OR IGNORE INTO closures VALUES(?,?)').run(this.budgetId,now())
  }
  requestSnapshot(owner){
    const rows=this.db.prepare(`SELECT r.json FROM requests r
      LEFT JOIN tasks t ON t.child=r.session
      WHERE r.budget=? AND (r.session=? OR t.owner=?)`).all(this.budgetId,owner,owner).map(decode)
    const used=this.db.prepare('SELECT count(*) AS n FROM requests WHERE budget=?').get(this.budgetId).n
    return {as_of:now(),scope:'读取结果时当前计量分区的账本快照；不包含此后生成最终回答的请求',
      conversation:{requests:rows.length,by_role:Object.fromEntries(['coordinator','analysis','planning','writing'].map(role=>[role,rows.filter(r=>r.role===role).length]))},
      budget:{id:this.budgetId,mode:this.requestLimit===null?'usage':'limited',limit:this.requestLimit,used,remaining:this.requestLimit===null?null:Math.max(0,this.requestLimit-used)},
      includes:'主 Agent、成员及同会话附带请求；失败也计数。最终用量以 Dashboard 账本为准。'}
  }
  overview({from,to,path,period,buckets=24}={}){
    if(from!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(from)||to!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(to))throw Error('日期格式无效')
    const clock=Date.now(),window=period?usageWindow(period,clock):null
    if(period&&(!Number.isInteger(buckets)||buckets<2||buckets>96))throw Error('Invalid Agent bucket count')
    const start=window?(period==='all'?'':new Date(window.from).toISOString()):from?new Date(from+'T00:00:00').toISOString():'',end=window?new Date(window.to).toISOString():to?new Date(new Date(to+'T00:00:00').getTime()+86400000).toISOString():'9999'
    const rows=this.db.prepare('SELECT json FROM requests WHERE started>=? AND started<? AND NOT EXISTS (SELECT 1 FROM dashboard_archives a WHERE a.request_id=requests.id) ORDER BY started, rowid').all(start,end).map(decode).filter(r=>!path||r.path===path)
    const roles=['coordinator','analysis','planning','writing'].map(role=>{
      const own=rows.filter(r=>r.role===role),sum=key=>own.reduce((n,r)=>n+(Number.isFinite(r.usage?.[key])?r.usage[key]:0),0)
      const input=sum('inputTokens')+sum('cacheReadTokens')+sum('cacheWriteTokens'),output=sum('outputTokens')
      return {role,requests:own.length,inputTokens:input,outputTokens:output,tokens:input+output,knownUsage:own.filter(r=>r.usage).length,failed:own.filter(r=>r.status==='failed').length,pending:own.filter(r=>r.status==='pending').length}
    })
    const totalTokens=roles.reduce((n,r)=>n+r.tokens,0)
    for(const row of roles){row.requestShare=rows.length?row.requests/rows.length:0;row.tokenShare=totalTokens?row.tokens/totalTokens:0}
    return {monitoring:{...summarizeRequests(rows),...period?{timeline:requestTimeline(rows,period,buckets,clock)}:{}},roles,requests:rows.length,tokens:totalTokens,unknownUsage:rows.filter(r=>!r.usage).length,
      budget:{id:this.budgetId,mode:this.requestLimit===null?'usage':'limited',limit:this.requestLimit,used:this.db.prepare('SELECT count(*) AS n FROM requests WHERE budget=?').get(this.budgetId).n,closed:this.requestLimit!==null&&!!this.db.prepare('SELECT 1 FROM closures WHERE id=?').get(this.budgetId)},
      tasks:this.tasks().filter(t=>(!path||t.path===path)&&t.created_at>=start&&t.created_at<end).map(({id,role,status,created_at,updated_at,child,owner,objective,artifact,error})=>({id,role,status,created_at,updated_at,child,owner,objective,summary:artifact?.summary,error})).slice(-100)}
  }
}
