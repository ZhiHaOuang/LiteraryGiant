import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,renameSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {collectStoryView,READ_API} from './read-model.js'
import {digest} from './validate.js'
const FILES=['overview.json','records.json','timeline.json','sections/people.json','sections/plot.json','sections/world.json']
const SCHEMA='lg.story-data.snapshot.v1'
function safePath(path){let p=resolve(path);for(;;){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('资料快照路径不得经过符号链接');const parent=dirname(p);if(parent===p)break;p=parent}return resolve(path)}
function json(path){return JSON.parse(readFileSync(safePath(path),'utf8'))}
export function readStorySnapshot(directory){
 const root=safePath(directory),pointer=json(join(root,'CURRENT.json'))
 if(pointer.schema!=='lg.story-data.pointer.v1'||!/^([a-f0-9]{64})$/u.test(pointer.snapshot))throw Error('不支持的资料快照指针')
 const base=join(root,'snapshots',pointer.snapshot),manifest=json(join(base,'manifest.json'))
 if(manifest.schema!==SCHEMA||manifest.api_version!==READ_API||manifest.snapshot_id!==pointer.snapshot||Object.keys(manifest.files??{}).sort().join('|')!==[...FILES].sort().join('|'))throw Error('资料快照版本或文件清单不匹配')
 const data={}
 for(const name of FILES){const content=readFileSync(safePath(join(base,name)),'utf8');if(digest(content)!==manifest.files[name])throw Error('资料快照文件摘要不匹配：'+name);data[name]=JSON.parse(content)}
 const pack={overview:data['overview.json'],records:data['records.json'],timeline:data['timeline.json'],sections:{people:data['sections/people.json'],plot:data['sections/plot.json'],world:data['sections/world.json']}}
 if(digest(pack)!==manifest.snapshot_id||pack.overview.book_id!==manifest.book_id||pack.overview.data_revision!==manifest.data_revision||pack.timeline.data_revision!==manifest.data_revision)throw Error('资料快照内部版本不一致')
 return {manifest,...pack}
}
export function exportStorySnapshot(book,{output=join(book,'notes/story-data'),expected_revision}={}){
 const view=collectStoryView(book)
 if(expected_revision&&view.overview.data_revision!==expected_revision)throw Error('资料已变化，请重新读取后导出')
 const root=safePath(output),snapshot_id=digest(view),base=join(root,'snapshots',snapshot_id)
 const values={'overview.json':view.overview,'records.json':view.records,'timeline.json':view.timeline,
  'sections/people.json':view.sections.people,'sections/plot.json':view.sections.plot,'sections/world.json':view.sections.world}
 const files=Object.fromEntries(Object.entries(values).map(([name,value])=>[name,JSON.stringify(value,null,2)+'\n']))
 const manifest={schema:SCHEMA,api_version:READ_API,snapshot_id,data_revision:view.overview.data_revision,book_id:view.overview.book_id,contract:view.overview.contract,
  authority:'.literarygiant/story.sqlite3',files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,digest(text)]))}
 mkdirSync(safePath(base),{recursive:true,mode:0o700})
 for(const [name,text]of Object.entries({...files,'manifest.json':JSON.stringify(manifest,null,2)+'\n'})){
  const path=safePath(join(base,name));mkdirSync(safePath(dirname(path)),{recursive:true,mode:0o700})
  if(existsSync(path)){if(readFileSync(path,'utf8')!==text)throw Error('既有快照内容发生变化；保留原文件并停止：'+name)}else writeFileSync(path,text,{flag:'wx',mode:0o600})
 }
 const pointer={schema:'lg.story-data.pointer.v1',snapshot:snapshot_id}
 const current=safePath(join(root,'CURRENT.json')),next=join(root,'CURRENT.'+randomUUID()+'.tmp')
 if(!existsSync(current)||readFileSync(current,'utf8')!==JSON.stringify(pointer,null,2)+'\n'){writeFileSync(next,JSON.stringify(pointer,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(next,current)}
 const readme=join(root,'README.md')
 if(!existsSync(readme))writeFileSync(readme,'# 书级故事资料\n\n权威资料保存在 `.literarygiant/story.sqlite3`；正文文件在 `manuscript/chapters/`。本目录为可重新生成的只读快照与整理审计，修改这些 JSON 不会改动正式资料。\n\n- `CURRENT.json`：当前快照指针。\n- `snapshots/<摘要>/manifest.json`：接口版本、数据版本和每个文件的 SHA-256。\n- `records.json`：完整候选／确认状态、稳定 ID、字段、证据和依赖状态。\n- `overview.json`：覆盖范围和待核对项。\n- `timeline.json`：部分时间顺序；不是唯一全书年表。\n- `sections/*.json`：人物／情节／环境的记录 ID 索引。\n- `reviews/`：每次整理的候选批次、变更说明及导入回执（如有）。\n\n后续界面通过 `api/lg/books` 的 `story-overview`、`story-data`、`story-time`、`story-data-history` 读取；前三者版本为 `lg.story-data.read.v1`。离线读取使用 lg-books 的 `readStorySnapshot()`，校验摘要后再使用。旧快照与旧修订保留。作者采纳仍须另行批准。\n',{flag:'wx',mode:0o600})
 readStorySnapshot(root)
 return {directory:root,snapshot_id,data_revision:manifest.data_revision,records:view.records.length}
}
