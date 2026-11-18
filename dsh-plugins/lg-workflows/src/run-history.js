import {hash} from './store.js'

const exists=db=>db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_run_history'").get()
function load(db,token){
  const row=exists(db)&&db.prepare('SELECT record FROM lg_run_history WHERE token=?').get(token)
  if(!row)throw new Error('未找到已导入的历史快照。')
  const record=JSON.parse(row.record)
  if(hash(record)!==token||record.project!==db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get()?.value)throw new Error('历史快照完整性校验失败。')
  return record
}
export async function runHistory(books,path,input){
  if(input.action==='legacy-list')return books.legacyRuns(path,input.before)
  if(input.action==='legacy-preview')return books.legacyRun(path,input.id)
  if(input.action==='history-list')return books.readState(path,db=>{
    if(input.before!=null&&(!Number.isSafeInteger(input.before)||input.before<1))throw new Error('快照分页位置无效。')
    const items=exists(db)?db.prepare(`SELECT rowid AS cursor,token,run_id AS id,imported,
      json_extract(record,'$.title') AS title,json_extract(record,'$.status') AS status FROM lg_run_history
      WHERE rowid<? ORDER BY rowid DESC LIMIT 21`).all(input.before??Number.MAX_SAFE_INTEGER):[]
    return {items:items.slice(0,20),next:items.length>20?items[19].cursor:null}
  })
  if(!/^[a-f0-9]{64}$/u.test(input.token))throw new Error('请先预览历史快照。')
  if(input.action==='history-read')return books.readState(path,db=>load(db,input.token))
  if(input.action==='history-version'){
    const record=books.readState(path,db=>load(db,input.token)),ref=record.versions.find(v=>v.version===input.version)
    if(!ref)throw new Error('所选版本不属于该历史快照。')
    return books.verifyOldVersion(path,ref)
  }
  if(input.action!=='legacy-import'||input.confirmed!==true)throw new Error('请先确认导入预览。')
  const replay=db=>{
    const prior=exists(db)&&db.prepare('SELECT run_id FROM lg_run_history WHERE token=?').get(input.token)
    if(prior){if(prior.run_id!==input.id)throw new Error('快照不属于该运行。');return load(db,input.token)}
    return null
  }
  const saved=books.readState(path,replay)
  if(saved)return saved
  const {record,token}=await books.legacyRun(path,input.id)
  if(token!==input.token)throw new Error('原运行记录已变化，请重新预览。')
  return books.changeState(path,db=>{
    const existing=replay(db)
    if(existing)return existing
    if(record.project!==db.prepare("SELECT value FROM project_meta WHERE key='project_id'").get()?.value)throw new Error('作品已变化。')
    db.exec('CREATE TABLE IF NOT EXISTS lg_run_history(token TEXT PRIMARY KEY,run_id TEXT NOT NULL,imported TEXT NOT NULL,record TEXT NOT NULL)')
    db.prepare('INSERT INTO lg_run_history VALUES (?,?,?,?)').run(token,record.id,new Date().toISOString(),JSON.stringify(record))
    return record
  })
}
