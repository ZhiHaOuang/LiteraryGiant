import { sceneSequence, nextScene, sequenceSchema } from './sequence.js'
import {chapterSequence,chapterSequenceSchema,nextChapter} from './chapter-sequence.js'
import { hash } from './store.js'
import { freezeRules, repairTask } from './chapter-rules.js'
import {ideasTask,draftFromChoice} from './chapter-ideas.js'
const request = value => { if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('步骤要求为 1–2000 字。');return value }
export function definition(agents, path, input, books, review) {
  if (![undefined,'revision','chapter','scenes','chapters'].includes(input.kind)) throw new Error('未知文学工作流类型。')
  const chapter = input.kind === 'chapter', limits = input.limits
  if (!limits || !Number.isSafeInteger(limits.maxCalls) || limits.maxCalls < 2 || limits.maxCalls > 6 || !Number.isFinite(limits.maxReservedCny) || limits.maxReservedCny <= 0 || limits.maxReservedCny > 100) throw new Error('请选择 2–6 次调用及有效的工作流预算上限（最多100元）。')
  const budget = {maxCalls:limits.maxCalls,maxReservedMicros:Math.floor(limits.maxReservedCny*1e6)}
  if(input.ideas!==undefined&&!chapter)throw new Error('构思起草仅适用于整章流程。')
  if (input.rules !== undefined && !chapter) throw new Error('整章规则仅适用于整章生成流程。')
  if (input.kind==='chapters')return chapterSequence(books,agents,path,input,budget)
  if (input.kind === 'scenes') return sceneSequence(books,agents,path,input,budget)
  const source = Object.fromEntries(['document','version','token','start','end'].map(key => [key,input.source?.[key]]))
  const task = { task:chapter?'draft-chapter':'polish',path,...source,request:request(input.request),role:input.role ?? (chapter?'chapter-writer':'manuscript-editor'),
    ...(input.references ? { references:input.references } : {}), ...(input.context ? { context:input.context } : {}) }
  const frozen = input.rules === undefined ? null : freezeRules(review,path,source,input.rules)
  if (frozen) task.request = request(task.request + '\n整章规则（逐字检查）\n' + frozen.instruction)
  const plan = agents.preview(task)
  if (plan.reservedCny > limits.maxReservedCny) throw new Error('首步预留超过工作流预算。')
  const value = { schema:chapter?'lg.chapter-workflow.v1':'lg.revision-workflow.v1',task,reviewRequest:request(input.reviewRequest),reviewRole:input.reviewRole ?? 'critic',
    limits:budget,firstSignature:plan.signature,...(frozen ? {rules:frozen.rules,authorRequest:input.request} : {}) }
  if (!agents.roles().some(role => role.id === value.reviewRole && role.enabled && role.tasks.includes('manuscript-review'))) throw new Error('请启用支持正文审阅的专家、lg-review 和 lg-context。')
  if(input.ideas!==undefined){
    const task=ideasTask(path,input,value.task),first=agents.preview(task)
    if(Math.round((first.reservedCny+plan.reservedCny)*1e6)>budget.maxReservedMicros)throw new Error('构思与起草预留超过流程预算。')
    value.ideas={task,signature:first.signature}
    return {definition:value,plan:first,token:hash({path,value})}
  }
  return { definition:value,plan,token:hash({path,value}) }
}
export function nextPlan(books, agents, review, path, state, feedback,planning) {
  if (!['ready','awaiting-author','awaiting-scene','awaiting-direction','awaiting-chapter'].includes(state.status)) throw new Error('工作流不能开始新步骤；运行中请读取状态，中断任务请恢复原步骤。')
  if (state.steps.length >= state.definition.limits.maxCalls) throw new Error('已达到工作流调用上限，继续不会重置额度。')
  if(state.definition.schema===chapterSequenceSchema){
    const {task,plan}=nextChapter(books,agents,path,state)
    return pricedStep(state,task,plan)
  }
  if (state.definition.schema === sequenceSchema) {
    const {task,plan} = nextScene(books,agents,path,state)
    return pricedStep(state,task,plan)
  }
  let base = state.definition.task
  const previous = state.steps.at(-1),ideas=state.definition.ideas
  // Freeze the original author-selected scope, model settings, references and context across the workflow.
  if (agents.preview(base).signature !== state.definition.firstSignature) throw new Error('工作流原文、资料或模型设置已变化，请检查已有结果。')
  if(ideas){
    if(!previous){
      const plan=agents.preview(ideas.task)
      if(plan.signature!==ideas.signature)throw new Error('构思来源或专家配置已变化，请重新预览。')
      return pricedStep(state,ideas.task,plan)
    }
    const draft=state.steps[1]
    if(draft){
      base={...base,context:draft.task.context}
      if(agents.preview(base).signature!==draft.plan.signature)throw new Error('起草所用方向或输入已变化。')
    }else base=draftFromChoice(planning,path,base,previous.result.proposal)
  }
  let task
  if (feedback?.checks !== undefined && (!state.definition.rules || !previous?.result?.candidate)) throw new Error('请先选择带规则的整章候选。')
  if (!previous || previous.result?.proposal) task = base
  else if (previous.result?.candidate) {
    const body = books.manuscript(path, base.document, previous.result.candidate.version)
    if (body.selected.state !== 'candidate' || body.token !== base.token) throw new Error('候选已处理或当前正文发生变化。')
    task = feedback?.checks !== undefined ? repairTask(review,path,state,body,feedback,base) : { task:'manuscript-review',path,role:state.definition.reviewRole,request:state.definition.reviewRequest,requirements:base.request,
      target:{section:'manuscript',id:base.document,version_id:body.selected.id,token:body.token,start:previous.result.range.start,end:previous.result.range.end},
      ...(base.context ? {context:base.context} : {}) }
  } else if (previous.result?.report) {
    if (!feedback || !review) throw new Error('请先审阅报告并明确选择本次要修改的问题。')
    const report = review.read(path, previous.result.report.run)
    task = { ...base,...report.revisionTarget,...(base.task==='draft-chapter'?{task:'polish',role:'manuscript-editor'}:{}),request:request(feedback.request),feedback:{run:report.run,issues:feedback.issues} }
  } else throw new Error('上一步没有可继续的候选或审阅结果。')
  return pricedStep(state,task,agents.preview(task))
}
function pricedStep(state, task, plan) {
  const operation = `${state.id}-${state.steps.length + 1}`
  const reservedMicros = Math.round(plan.reservedCny * 1e6)
  if (state.reservedMicros + reservedMicros > state.definition.limits.maxReservedMicros) throw new Error('已达到工作流预算上限；未发起新调用。')
  return { task:{...task,operation,signature:plan.signature},plan,reservedMicros,token:hash({state,task,signature:plan.signature}) }
}
export function resultSummary(result, task) {
  const value = { status:result.status, ...(result.validationError ? {error:result.validationError} : {}), ...(result.candidateError ? {error:result.candidateError} : {}),
    ...(result.run ? {call:{id:result.run.id,status:result.run.status,reservedCny:result.run.reservedCny,usage:result.run.result?.usage,elapsedMs:result.run.result?.elapsedMs,estimatedCny:result.run.result?.estimatedCny}} : {}) }
  if (task.task === 'draft-scene' && result.status === 'candidate-ready') {
    return { ...value,candidate:result.candidate,range:{start:0,end:result.output.content.length},changed:true,contentHash:hash(result.output.content) }
  }
  if(task.task==='ideas'&&result.status==='planning-ready'){
    const {document_id,options_version_id,options_version_number,options}=result.proposal
    return {...value,proposal:{document_id,options_version_id,options_version_number,options}}
  }
  if (result.status === 'candidate-ready') return { ...value,candidate:result.candidate,range:{start:task.start,end:task.start+result.output.replacement.length},changed:result.output.replacement !== undefined }
  if (result.status === 'review-ready' && result.report) return { ...value,report:{run:result.report.run,issues:result.report.issues.length,stale:result.report.stale} }
  return value
}
