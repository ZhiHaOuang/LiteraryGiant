#!/usr/bin/env node
// Offline author operation. No model calls, no credential reads and no automatic restore.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,realpathSync,statSync,chmodSync} from 'node:fs'
import {join,resolve,isAbsolute,relative,sep} from 'node:path'
import {DatabaseSync,backup} from 'node:sqlite'
import {pathToFileURL} from 'node:url'

const help='Usage: node migrate-story-time.mjs --book ABS_PATH [--apply --token TOKEN --backup-dir EXISTING_ABS_DIR]'
const inside=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r))}

function argumentsFor(argv){
 const out={apply:false}
 for(let i=0;i<argv.length;i++){
  const flag=argv[i]
  if(flag==='--help'){if(argv.length!==1)throw Error(help);return {help:true}}
  if(flag==='--apply'){if(out.apply)throw Error('重复参数 --apply');out.apply=true;continue}
  const key={'--book':'book','--token':'token','--backup-dir':'backupDir'}[flag]
  if(!key||out[key]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(help)
  out[key]=argv[++i]
 }
 if(!out.book||!isAbsolute(out.book))throw Error('--book 必须是作品的绝对目录。')
 if(out.apply&&(!out.token||!out.backupDir||!isAbsolute(out.backupDir)))throw Error('实际迁移需要预览 token 和已存在的书外绝对备份目录。')
 if(!out.apply&&(out.token!==undefined||out.backupDir!==undefined))throw Error('--token 和 --backup-dir 仅用于 --apply。')
 return out
}

export async function runMigrationCLI(argv){
 const args=argumentsFor(argv)
 if(args.help)return {usage:help}
 const {previewStoryMigration,migrateStoryData}=await import('../lg-books/src/story-data/store.js')
 const book=realpathSync(args.book),preview=previewStoryMigration(book)
 if(!args.apply)return {mode:'preview',book,...preview}
 if(args.token!==preview.token)throw Error('预览已变化，请重新预览；未执行迁移。')
 if(preview.issues.length)throw Error('迁移预检存在问题：'+preview.issues.join('；'))
 const backupDir=realpathSync(args.backupDir)
 if(!statSync(backupDir).isDirectory()||inside(book,backupDir))throw Error('备份目录必须是已存在且位于作品之外的目录。')
 if(!preview.needed)return {mode:'unchanged',book,...preview}
 const container=mkdtempSync(join(backupDir,'story-time-'))
 chmodSync(container,0o700)
 try{
 const backupBook=join(container,'book'),state=join(backupBook,'.literarygiant')
 mkdirSync(state,{recursive:true,mode:0o700})
 const projectPath=join(book,'.literarygiant/project.json'),project=readFileSync(projectPath)
 writeFileSync(join(state,'project.json'),project,{flag:'wx',mode:0o600})
 const databasePath=join(state,'story.sqlite3')
 const source=new DatabaseSync(join(book,'.literarygiant/story.sqlite3'),{readOnly:true,allowExtension:false})
 try{await backup(source,databasePath)}finally{source.close()}
 chmodSync(databasePath,0o600)
 const copy=new DatabaseSync(databasePath,{readOnly:true,allowExtension:false})
 try{
  const checks=copy.prepare('PRAGMA quick_check').all()
  if(!checks.length||checks.some(r=>Object.values(r)[0]!=='ok'))throw Error('备份数据库完整性检查失败；未执行迁移。')
 }finally{copy.close()}
 const savedPreview=previewStoryMigration(backupBook)
 if(savedPreview.token!==preview.token||!readFileSync(projectPath).equals(project)||previewStoryMigration(book).token!==preview.token)
  throw Error('备份期间作品或契约依据发生变化；备份已保留，未执行迁移。请重新预览。')
 const operation='story-time-migration:'+args.token
 const record={schema:'lg.story-time-backup.v1',book_id:JSON.parse(project).project_id,source:book,backup:backupBook,
  from_version:preview.from_version,to_version:preview.to_version,token:preview.token,operation,
  scope:['.literarygiant/project.json','.literarygiant/story.sqlite3'],created_at:new Date().toISOString()}
 writeFileSync(join(container,'backup.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600})
 const migration=migrateStoryData(book,{token:args.token,operation})
 const result={mode:'applied',book,backup:backupBook,database_backup:databasePath,...migration}
 writeFileSync(join(container,'migration.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600})
 return result
 }catch(error){
  throw new Error(`${error.message} 检查或备份产物保留于 ${container}；请核对原作品与迁移回执，勿直接覆盖恢复。`,{cause:error})
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log(JSON.stringify(await runMigrationCLI(process.argv.slice(2)),null,2))}
 catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1}
}
