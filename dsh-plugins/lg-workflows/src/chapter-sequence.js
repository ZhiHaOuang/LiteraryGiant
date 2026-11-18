import {hash} from './store.js'
import {followsCandidate} from './sequence.js'

export const chapterSequenceSchema='lg.chapter-sequence.v1'

function chapterTask(path,value,chapter,body,previous){
  let context=value.context
  if(context?.decisions)context={...context,chapter:chapter.document}
  if(previous&&value.carryPrevious)context={...context,previousChapter:previous}
  return {task:'draft-chapter',path,role:value.role,request:value.request+'\n本章要求\n'+chapter.request,
    document:chapter.document,version:body.selected.id,start:0,end:body.selected.content.length,token:body.token,
    ...(context?{context}:{}),references:value.references}
}

export function chapterSequence(books,agents,path,input,limits){
  const chapters=input.chapters,carryPrevious=input.carryPrevious??true
  if(!Array.isArray(chapters)||chapters.length<2||chapters.length>limits.maxCalls||
    new Set(chapters.map(c=>c?.document)).size!==chapters.length)throw new Error('请选择 2–6 个不同章节，并为每章预留一次调用。')
  if(typeof input.request!=='string'||!input.request.trim()||typeof carryPrevious!=='boolean')throw new Error('请填写跨章共同要求。')
  if(carryPrevious&&input.context?.audience&&input.context.audience!=='author')throw new Error('加入已采用章末须使用作者视角。')
  if(['chapter','previousChapter','direction','scene'].some(k=>input.context?.[k]!=null))throw new Error('跨章共享材料不能绑定单个章节或场景。')
  const value={schema:chapterSequenceSchema,request:input.request,role:input.role??'chapter-writer',carryPrevious,
    limits,chapters:[],context:input.context??null,references:input.references??[]}
  let first,cost=0
  for(const c of chapters){
    if(!Number.isSafeInteger(c?.document)||typeof c.request!=='string'||!c.request.trim())throw new Error('每章都需要目标和创作要求。')
    const body=books.manuscript(path,c.document)
    if(body.document.kind!=='chapter')throw new Error('跨章流程只接受章文档。')
    const task=chapterTask(path,value,c,body),plan=agents.preview(task)
    first??=plan;cost+=Math.round(plan.reservedCny*1e6)
    value.chapters.push({document:c.document,title:body.document.title,request:c.request,signature:plan.signature})
  }
  if(cost>limits.maxReservedMicros)throw new Error('各章基础预留合计超过流程预算。')
  return {definition:value,plan:first,token:hash({path,value})}
}

export function chapterProgress(books,path,state){
  const decisions=[]
  let previous
  for(const step of state.steps){
    const version=step.result?.candidate?.version
    if(!version)break
    const body=books.manuscript(path,step.task.document,version)
    if(hash(body.selected.content)!==step.result.contentHash)throw new Error('已登记的章节候选内容发生变化。')
    const used=step.plan.context?.receipt.sources.find(s=>s.kind==='chapter-ending')
    if(used&&(!previous||used.id!==previous.document||used.identity.version!==previous.version||used.sourceHash!==previous.digest))
      throw new Error('先前步骤引用的章末已变化，请复核已有候选。')
    if(['accepted','final'].includes(body.document.state)&&followsCandidate(books,path,body.document.id,body.document.activeVersion,version)){
      previous={document:body.document.id,version:body.document.activeVersion,digest:hash(body.document.content)}
      decisions.push({status:'accepted',version:previous.version})
    }else decisions.push({status:body.selected.state==='rejected'?'rejected':'pending',version})
  }
  return {decisions,previous}
}

export function nextChapter(books,agents,path,state){
  const value=state.definition,chapter=value.chapters[state.steps.length]
  if(!chapter)throw new Error('已完成所选章节的起草。')
  const {decisions,previous}=chapterProgress(books,path,state)
  if(decisions.length!==state.steps.length||decisions.some(d=>d.status==='pending'))throw new Error('请先采用或拒绝前章候选，再起草下一章。')
  const body=books.manuscript(path,chapter.document),base=chapterTask(path,value,chapter,body),initial=agents.preview(base)
  if(initial.signature!==chapter.signature)throw new Error('待起草章节、材料或模型已变化，请重新规划。')
  if(!previous||!value.carryPrevious)return {task:base,plan:initial}
  const task=chapterTask(path,value,chapter,body,{document:previous.document,version:previous.version}),plan=agents.preview(task)
  if(!plan.context?.receipt.sources.some(s=>s.kind==='chapter-ending'&&s.id===previous.document&&s.identity.version===previous.version))
    throw new Error('已采用章末未进入输入，请检查上下文预算。')
  return {task,plan}
}
