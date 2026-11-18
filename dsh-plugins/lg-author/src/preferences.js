import { createHash } from 'node:crypto'
import { openSync, closeSync, fstatSync, readFileSync, constants, lstatSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const defaults = { name:'作者',detail:'balanced',writing:'' }
export function validate(value,scope) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!(scope==='book'?['writing']:['name','detail','writing']).includes(key)))throw new Error('偏好字段无效。')
  for(const [key,text] of Object.entries(value))if(typeof text!=='string'||text.length>(key==='writing'?16000:key==='name'?60:20))throw new Error('称呼最多60字，写作偏好最多16000字。')
  if(value.detail!==undefined&&!['concise','balanced','detailed'].includes(value.detail))throw new Error('回复详略无效。')
  return scope==='book'?{...value}:{...defaults,...value,name:value.name?.trim()||'作者'}
}
export function legacy(path,scope) {
  if(!isAbsolute(path))throw new Error('旧偏好文件需要绝对路径。')
  let fd
  try{
    if(lstatSync(dirname(path)).isSymbolicLink())throw new Error('旧偏好目录不能是符号链接。')
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    const stat=fstatSync(fd)
    if(!stat.isFile()||stat.size>100000)throw new Error('旧偏好文件类型无效或超过上限。')
    const raw=readFileSync(fd,'utf8'),value=JSON.parse(raw)
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('旧偏好文件格式无效。')
    const fields=scope==='book'?['writing']:['name','detail','writing']
    const selected=Object.fromEntries(fields.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]))
    return {values:validate(selected,scope),source:'legacy',revision:0,digest:hash(raw)}
  }catch(error){
    if(error.code==='ENOENT')return {values:scope==='book'?{}:{...defaults},source:'default',revision:0}
    throw new Error('旧偏好不可读取：'+(error.code==='ELOOP'?'不允许符号链接。':error.message))
  }finally{if(fd!==undefined)closeSync(fd)}
}
export function effective(personal,book) {
  const override=Object.hasOwn(book.values,'writing')
  return {...personal.values,...(override?{writing:book.values.writing}:{}),writingScope:override?'book':'personal'}
}
export function record(db,scope,fallback) {
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_author_preferences'").get()
  const row=exists&&db.prepare('SELECT * FROM lg_author_preferences WHERE scope=?').get(scope)
  return row?{values:validate(JSON.parse(row.values_json),scope),revision:row.revision,source:'native',updatedAt:row.updated_at}:fallback()
}
export function persist(db,scope,values,previous,operation,signature) {
  db.exec(`CREATE TABLE IF NOT EXISTS lg_author_preferences(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,values_json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lg_author_actions(id TEXT PRIMARY KEY,signature TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)`)
  const updatedAt=new Date().toISOString(),revision=previous.revision+1,result={scope,values,revision,source:'native',updatedAt}
  db.prepare('INSERT INTO lg_author_preferences VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json,updated_at=excluded.updated_at').run(scope,revision,JSON.stringify(values),updatedAt)
  db.prepare('INSERT INTO lg_author_actions VALUES (?,?,?,?)').run(operation,signature,JSON.stringify(result),updatedAt)
  return result
}
export function replay(db,id,signature) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_author_actions'").get())return null
  const row=db.prepare('SELECT * FROM lg_author_actions WHERE id=?').get(id)
  if(!row)return null
  if(row.signature!==signature)throw new Error('同一保存操作不能更换偏好。')
  return JSON.parse(row.result_json)
}
