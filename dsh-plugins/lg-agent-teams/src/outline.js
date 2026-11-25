import {createHash} from 'node:crypto'
import {objectSchema} from './contracts.js'

const string = {type:'string'}, integer = {type:'integer'}
const array = items => ({type:'array',items})
const evidence = objectSchema({chapter:integer,paragraph:integer,quote:string})
const entry = objectSchema({id:string,title:string,section:{enum:['people','plot','world'],type:'string'},
  text:string,basis:{type:'string',enum:['text','inference']},links:array(string),evidence:array(evidence)})
entry.properties.module = {type:'string',description:'来自 character_protocol 的模块标识；旧摘要省略'}
entry.properties.entries = {type:'array',items:{type:'object',additionalProperties:true},description:'完整人物条目集；字段约束见 lg_team_context.character_protocol.entry_schema'}
export const proposalSchema = objectSchema({beat:string,changes:array(entry)})
export const reviewSchema = objectSchema({decision:{type:'string',enum:['approved','rejected']},reason:string})
export const summaryModule = 'core@1.summary'

function inScope(source,item) {
  if (!item) return
  if (!item.evidence.every(e=>source.chapters.some(ch=>ch.document_id===e.document_id && ch.version_id===e.version_id))) {
    throw Error('该档案引用本任务范围外的原文，请重新选择包含原依据的章节')
  }
}

export function priorKey(id,module=summaryModule) {
  return module===summaryModule?id:id+'/'+module
}

export function priorSummary(outline,source,id,module=summaryModule) {
  if (module!==summaryModule && !outline.characterProtocol().groups.some(group=>group.module===module)) throw Error('不支持的 Main 模块')
  const [prior] = outline.history(source.path,{id,module,limit:1})
  inScope(source,prior?.item)
  return prior ? {revision:prior.revision,item:prior.item} : {revision:0,item:null}
}

export function proposeSummary(outline,books,source,task,input) {
  if (!Array.isArray(input.changes) || input.changes.length>24) throw Error('一次最多更新 24 个模块')
  // Team source IDs use a serialized-object digest. Outline binds evidence to raw UTF-8 manuscript bytes.
  const hashes = books.readState(source.path,db=>{
    const query=db.prepare('SELECT content FROM document_versions WHERE id=? AND document_id=?')
    return new Map(source.chapters.map(ch=>{
      const row=query.get(ch.version_id,ch.document_id)
      if (!row) throw Error('原文版本不可用')
      return [ch.version_id,createHash('sha256').update(row.content).digest('hex')]
    }))
  })
  const changes=input.changes.map(item=>{
    const module=item.module??summaryModule, key=priorKey(item.id,module)
    if (!Object.hasOwn(task.outline_priors??{},key)) throw Error('请先用 lg_outline_prior 读取拟更新的每个档案')
    return {...item,expected_revision:task.outline_priors[key],module,evidence:item.evidence.map(e=>{
      const ch=source.chapters.find(ch=>ch.number===e.chapter)
      if (!ch || !Number.isSafeInteger(e.paragraph) || !ch.paragraphs[e.paragraph-1]?.includes(e.quote)) throw Error('引文与所选章节或段落不符')
      return {document_id:ch.document_id,version_id:ch.version_id,sha256:hashes.get(ch.version_id),paragraph:e.paragraph,quote:e.quote}
    })}
  })
  return outline.propose(source.path,{schema:'lg.outline.change.v1',book_id:source.book_id,beat:input.beat,changes},task.child)
}

export function reviewTarget(outline,store,source,task) {
  const proposal=store.task(task.inputs[0])
  if (proposal.owner!==task.owner || proposal.source_id!==task.source_id || proposal.child===task.child ||
      proposal.status!=='completed' || proposal.outline_action!=='propose' || !proposal.artifact?.token) throw Error('需要同一主会话和来源的独立提议')
  const diff=outline.inspect(source.path,proposal.artifact.token)
  if (diff.actor!==proposal.child || diff.book_id!==source.book_id) throw Error('提议身份或作品不符')
  for(const {before,after} of diff.changes){inScope(source,before);inScope(source,after)}
  return diff
}

export function taskTools(task) {
  if (task?.outline_action==='propose') return ['lg_team_context','lg_outline_prior','lg_outline_propose']
  if (task?.outline_action==='review') return ['lg_team_context','lg_outline_review']
  return ['lg_team_context','lg_'+task.role+'_submit']
}

