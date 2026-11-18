import { DatabaseSync } from 'node:sqlite'
import { chmodSync,lstatSync } from 'node:fs'
import { isAbsolute,join } from 'node:path'
import { hash,validate,legacy,effective,record,persist,replay } from './preferences.js'

export function createAuthor(books,storagePath,legacyPersonalPath) {
  if(!isAbsolute(storagePath))throw new Error('个人偏好数据库需要绝对路径。')
  try{if(lstatSync(storagePath).isSymbolicLink())throw new Error('个人偏好数据库不能是符号链接。')}catch(error){if(error.code!=='ENOENT')throw error}
  const personalDb=new DatabaseSync(storagePath,{allowExtension:false});chmodSync(storagePath,0o600);personalDb.exec('PRAGMA busy_timeout=2000')
  const personal=()=>record(personalDb,'personal',()=>legacy(legacyPersonalPath,'personal'))
  const book=(path,db)=>record(db,'book',()=>legacy(join(path,'.literarygiant/preferences.json'),'book'))
  const scopeRecord=(path,scope,db)=>scope==='personal'?personal():book(path,db)
  const transact=(path,scope,write,fn)=>{
    if(!['personal','book'].includes(scope))throw new Error('偏好范围无效。')
    if(scope==='book')return books[write?'changeState':'readState'](path,fn)
    if(write)personalDb.exec('BEGIN IMMEDIATE')
    try{const result=fn(personalDb);if(write)personalDb.exec('COMMIT');return result}finally{if(write&&personalDb.isTransaction)personalDb.exec('ROLLBACK')}
  }
  const preview=(path,change,db)=>{
    const values=validate(change.values,change.scope),before=scopeRecord(path,change.scope,db)
    return {scope:change.scope,before,after:values,token:hash({owner:change.scope==='book'?path:storagePath,before,values})}
  }
  return {
    read(path) {
      const p=personal(),b=path?books.readState(path,db=>book(path,db)):{values:{},source:'default',revision:0}
      return {personal:p,book:b,effective:effective(p,b)}
    },
    preview(path,change) {return transact(path,change?.scope,false,db=>preview(path,change,db))},
    apply(path,change,token,operation) {
      if(typeof operation!=='string'||!/^[\w-]{16,80}$/u.test(operation))throw new Error('偏好操作标识无效。')
      return transact(path,change?.scope,true,db=>{
        const signature=hash({scope:change.scope,values:change.values,token}),old=replay(db,operation,signature)
        if(old)return old
        const planned=preview(path,change,db)
        if(planned.token!==token)throw new Error('偏好已变化，请重新预览。')
        return persist(db,change.scope,planned.after,planned.before,operation,signature)
      })
    },
    history(path,scope,offset=0) {
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('偏好历史分页无效。')
      return transact(path,scope,false,db=>{
        if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_author_actions'").get())return {items:[],nextOffset:null}
        const rows=db.prepare('SELECT id,result_json,created_at FROM lg_author_actions ORDER BY rowid DESC LIMIT 21 OFFSET ?').all(offset)
        return {items:rows.slice(0,20).map(row=>({operation:row.id,...JSON.parse(row.result_json)})),nextOffset:rows.length>20?offset+20:null}
      })
    },
    material(path,task) {
      const writing=['polish','ideas','scene-plan','draft-scene','draft-chapter','review','manuscript-review','plan-review'].includes(task)
      const p=personal(),b=writing?books.readState(path,db=>book(path,db)):{values:{}}
      const merged=effective(p,b),values={name:merged.name,detail:merged.detail,...(writing?{writing:merged.writing}: {})}
      if(values.name==='作者'&&values.detail==='balanced'&&!values.writing)return undefined
      return {values,receipt:{schema:'lg.author-preferences.v1',personal:{source:p.source,revision:p.revision},
        ...(writing?{book:{source:b.source,revision:b.revision},writingScope:merged.writingScope}:{}),digest:hash(values)}}
    },
    close:()=>personalDb.close(),
  }
}
