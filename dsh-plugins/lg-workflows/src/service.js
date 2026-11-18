import { hash, now, identity, load, save, expose, listing } from './store.js'
import { savedDraftResult } from './sequence.js'
import { definition, nextPlan, resultSummary } from './plans.js'
import { candidateChecks } from './chapter-rules.js'
import {chapterProgress} from './chapter-sequence.js'
import {currentChoice,choicePreview} from './chapter-ideas.js'

export function createWorkflows(books, agents, review = () => undefined,planning=()=>undefined) {
  const active = new Map(), pending = new Set(), lifetime = new AbortController()
  const read = (path,id) => books.readState(path,db=>load(db,id))
  const change = (path,id,fn) => books.changeState(path,db=>{const state=load(db,id);fn(state);return save(db,state)})
  const key = (path,id) => hash({path,id})
  const finish = (path,id,operation,result) => change(path,id,state=>{
    const step=state.steps.find(step=>step.task.operation===operation)
    if (!step || step.status==='completed') return
    step.result=resultSummary(result,step.task);step.finishedAt=now()
    if(state.definition.chapters&&step.result.candidate)step.result.contentHash=hash(result.output.replacement)
    if (step.result.candidate && step.task.task!=='draft-scene') {
      const before=books.manuscript(path,step.task.document,step.task.version).selected.content.slice(step.task.start,step.task.end)
      step.result.changed=result.output.replacement!==before
    }
    const success=!!step.result.candidate||!!step.result.report||!!step.result.proposal
    step.status=success?'completed':'stopped'
    if(state.status==='stopped'||state.status==='closed')return
    state.status=!success||step.result.changed===false?'stopped':step.result.report?'awaiting-author':'ready'
    if (success && step.task.task==='draft-scene') state.status='awaiting-scene'
    if(success&&step.result.changed!==false&&state.definition.chapters)state.status='awaiting-chapter'
    if(step.result.proposal)state.status='awaiting-direction'
    if(step.result.changed===false)state.reason='本步未产生文字变化，停止继续调用。'
    else if(!success)state.reason=step.result.error??'调用未得到有效结果；不自动重试。'
  })
  async function execute(path,id,task,signal) {
    try { return finish(path,id,task.operation,await agents.run(task,signal)) }
    catch(error) { return change(path,id,state=>{const step=state.steps.find(s=>s.task.operation===task.operation);step.status='stopped';step.error=error.message;state.status='stopped';state.reason='步骤未完成，结果或用量可从原调用记录检查；未增加重试。'}) }
  }
  function tracked(path,id,fn) {
    const idKey=key(path,id)
    if(active.has(idKey))return Promise.resolve(expose(read(path,id)))
    const promise=Promise.resolve().then(fn);active.set(idKey,promise);pending.add(promise)
    const done=()=>{active.delete(idKey);pending.delete(promise)};promise.then(done,done);return promise
  }
  return {
    preview:(path,input)=>definition(agents,path,input,books,review()),
    checks:(path,id)=>candidateChecks(review(),path,read(path,id)),
    create(path,input,token,id) {
      identity(id)
      return books.changeState(path,db=>{
        let previous;try{previous=load(db,id)}catch(error){if(error.message!=='工作流不存在。')throw error}
        const requestHash=hash({input,token})
        if(previous){if(previous.requestHash!==requestHash)throw new Error('工作流标识不能更换任务。');return expose(previous)}
        const planned=definition(agents,path,input,books,review())
        if(planned.token!==token)throw new Error('工作流预览已变化。')
        return save(db,{id,requestHash,definition:planned.definition,title:input.request.slice(0,80),status:'ready',steps:[],reservedMicros:0,createdAt:now()})
      })
    },
    read(path,id) {
      const state=expose(read(path,id)), current=state.steps.at(-1)
      state.locallyRunning=active.has(key(path,id))
      if(state.definition.chapters){
        try{state.chapterDecisions=chapterProgress(books,path,state).decisions}catch(error){state.chapterProgressError=error.message}
      }
      if(state.status==='awaiting-direction'){
        try{state.choice=currentChoice(planning(),path,current.result.proposal)}catch(error){state.choiceError=error.message}
      }
      if(current) {
        try {state.currentCall=agents.status(current.task.operation)}
        catch(error){state.currentCallError=error.message}
      }
      return state
    },
    list:(path,offset)=>books.readState(path,db=>listing(db,offset)),
    choicePreview:(path,id,option)=>choicePreview(planning(),path,read(path,id),option),
    choose(path,id,option,token,operation){
      return books.changeState(path,db=>{
        const state=load(db,id),prior=state.choiceReceipt
        if(prior&&prior.operation===operation&&prior.token===token&&prior.option===option)return expose(state)
        const plan=choicePreview(planning(),path,state,option)
        if(plan.token!==token)throw new Error('方案或流程已变化，请重新预览。')
        const saved=planning().selectInTransaction(path,db,plan.change,plan.planningToken,operation)
        state.choiceReceipt={option,operation,token,version:saved.version_id}
        return save(db,state)
      })
    },
    nextPreview:(path,id,feedback)=>nextPlan(books,agents,review(),path,read(path,id),feedback,planning()),
    advance(path,id,feedback,token,signal) {
      if(lifetime.signal.aborted)throw new Error('工作流插件已停用。')
      return tracked(path,id,async()=>{
        let task
        const value=books.changeState(path,db=>{
          const state=load(db,id)
          if(state.steps.some(step=>step.token===token))return expose(state)
          const plan=nextPlan(books,agents,review(),path,state,feedback,planning())
          if(plan.token!==token)throw new Error('步骤或来源已变化，请重新预览。')
          task=plan.task;state.reservedMicros+=plan.reservedMicros;state.status='running'
          state.steps.push({task,token,plan:plan.plan,reservedMicros:plan.reservedMicros,status:'running',startedAt:now()})
          return save(db,state)
        })
        if(!task)return value
        return execute(path,id,task,AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]))
      })
    },
    recover(path,id,signal) {
      if(lifetime.signal.aborted)throw new Error('工作流插件已停用。')
      return tracked(path,id,async()=>{
        const state=read(path,id),step=state.steps.at(-1)
        const pendingResult=step?.status==='stopped'&&step.result?.status.endsWith('-pending')
        if(state.status==='closed'||!step||step.status!=='running'&&!pendingResult)return expose(state)
        const call=agents.status(step.task.operation)
        if(!call||call.status==='reserved')return {...expose(state),recoveryMessage:'原调用尚无确定结果；仅保留检查，不重新发起请求。'}
        if(call.status!=='succeeded')return finish(path,id,step.task.operation,{status:call.status,run:call})
        if(pendingResult)change(path,id,value=>{value.steps.at(-1).status='running';if(!value.stopRequested)value.status='running'})
        if (step.task.task==='draft-scene'||step.task.task==='draft-chapter') {
          const saved=savedDraftResult(books,path,step.task,call)
          if (saved) return finish(path,id,step.task.operation,saved)
        }
        return execute(path,id,step.task,AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]))
      })
    },
    stop(path,id,token,reason='作者停止后续步骤。') {
      if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('请填写停止理由。')
      const state=change(path,id,state=>{
        if(state.status==='closed'||state.status==='stopped'&&state.stopRequested)return
        if(hash(state)!==token)throw new Error('工作流已变化，请刷新。')
        state.status='stopped';state.stopRequested=true;state.reason=reason
      })
      const step=state.steps.at(-1);if(step?.status==='running')agents.cancel(step.task.operation)
      return state
    },
    close(path,id,token) {
      return change(path,id,state=>{
        if(state.status==='closed')return
        if(hash(state)!==token||state.status==='running')throw new Error('工作流已变化或仍在执行。')
        state.status='closed';state.reason='作者结束流程；候选和审阅记录保留，未自动采用正文或关闭问题。'
      })
    },
    async dispose() { lifetime.abort();await Promise.allSettled([...pending]) },
  }
}
