import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
export const LIMITS={requests:96,cellRequests:8,cellTokens:120000,maxOutput:2400}
export const usageTokens=u=>u&&['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].reduce((n,k)=>n+(u[k]??0),0)
export function inputBound(options){return Buffer.byteLength(JSON.stringify({system:options.system,messages:options.messages,tools:options.tools}))+4096+128*(options.messages?.length??0)}
export class Ledger{
 constructor(path,limits=LIMITS){this.limits=limits;this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,cell TEXT,json TEXT); CREATE TABLE IF NOT EXISTS cells(id TEXT PRIMARY KEY,status TEXT)')}
 rows(cell){return this.db.prepare('SELECT json FROM requests'+(cell?' WHERE cell=?':'')).all(...cell?[cell]:[]).map(r=>JSON.parse(r.json))}
 start(cell){this.db.prepare('INSERT INTO cells VALUES(?,?)').run(cell,'started')}
 reserve(cell,options){
  this.db.exec('BEGIN IMMEDIATE')
  try{
   const all=this.rows(),own=all.filter(r=>r.cell===cell),reserve=inputBound(options)+(options.maxTokens??this.limits.maxOutput)
   if(all.length>=this.limits.requests||own.length>=this.limits.cellRequests)throw Error('REQUEST_LIMIT')
   if(own.some(r=>r.boundExceeded))throw Error('TOKEN_BOUND_INVALID')
   if(own.reduce((n,r)=>n+(r.charged??r.reserved),0)+reserve>this.limits.cellTokens)throw Error('TOKEN_LIMIT')
   const row={id:randomUUID(),cell,session:options.sessionId,purpose:options.purpose??'agent-step',reserved:reserve,inputBound:inputBound(options),maxOutput:options.maxTokens,status:'pending',started:new Date().toISOString()}
   this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(row.id,cell,JSON.stringify(row));this.db.exec('COMMIT');return row
  }catch(e){this.db.exec('ROLLBACK');throw e}
 }
 finish(row,{usage,status,elapsedMs}){const actual=usageTokens(usage);const settled={...row,usage:usage??null,status,elapsedMs,charged:actual??row.reserved,boundExceeded:actual!==null&&actual!==undefined&&actual>row.reserved};this.db.prepare('UPDATE requests SET json=? WHERE id=?').run(JSON.stringify(settled),row.id);return settled}
 end(cell,status){this.db.prepare('UPDATE cells SET status=? WHERE id=?').run(status,cell)}
 close(){this.db.close()}
}
