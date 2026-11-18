import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const [root,book,file]=process.argv.slice(2)
const {importStoryData}=await import(pathToFileURL(root+'/dsh-plugins/lg-books/src/story-data/store.js'))
const {validateRecord,verifyEvidence,verifyGraph,references}=await import(pathToFileURL(root+'/dsh-plugins/lg-books/src/story-data/validate.js'))
const {openBook}=await import(pathToFileURL(root+'/dsh-plugins/lg-books/src/read.js'))
try {
 const input=JSON.parse(readFileSync(file,'utf8')),opened=openBook(book),errors=[]
 try {
  for(const item of input.records){try{validateRecord(item.record);verifyEvidence(opened.db,item.record)}catch(e){errors.push(item.record.id+': '+e.message)}}
  if(!errors.length){
   const exists=opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_story_data_records'").get()
   const old=exists?opened.db.prepare('SELECT v.payload_json FROM lg_story_data_records r JOIN lg_story_data_revisions v ON v.id=r.head').all().map(r=>JSON.parse(r.payload_json)):[]
   const byId=new Map([...old,...input.records.map(i=>i.record)].map(r=>[r.id,r]))
   for(const {record:r} of input.records){
    for(const [id,type] of references(r)){const t=byId.get(id);if(!t||type&&t.type!==type)errors.push(r.id+' 引用 '+id+' 需要 '+(type??'已有记录')+'，实际 '+(t?.type??'不存在'))}
    for(const l of r.links)if(l.relation==='before'&&(r.type!=='event'||byId.get(l.target)?.type!=='event'))errors.push(r.id+' 的 before 仅可连接两个 event；不得连接场景或线索')
   }
   if(!errors.length)try{verifyGraph([...byId.values()])}catch(e){errors.push(e.message)}
  }
 }finally{opened.close()}
 if(errors.length)throw Error(errors.join('\n'))
 console.log(JSON.stringify(importStoryData(book,input)))
}
catch(error){ console.error(error.message);process.exitCode=1 }
