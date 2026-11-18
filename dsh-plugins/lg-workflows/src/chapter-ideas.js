import {hash} from './store.js'

export function ideasTask(path, input, chapterTask) {
  const {id, request} = input.ideas ?? {}
  if (input.kind!=='chapter' || input.limits.maxCalls<3 || typeof id!=='string' || !/^[\w-]{16,50}$/.test(id))
    throw new Error('构思起草需要整章目标、独立构思标识和至少三次调用额度。')
  const context=chapterTask.context
  if (context && ((context.audience && context.audience!=='author') || context.decisions || context.direction ||
      (context.chapter && context.chapter!==chapterTask.document))) throw new Error('构思起草需要本章的作者材料，已有方向请单独用于起草。')
  if (typeof request!=='string'||!request.trim()||request.length>2000) throw new Error('请填写 1–2000 字的构思要求。')
  const slug='chapter-ideas-'+id
  return {task:'ideas',path,role:'plot',request,context,references:chapterTask.references,
    target:{slug,title:request.trim().slice(0,80),expected_version_id:0,topic:{scope:'chapter',document_id:chapterTask.document,key:slug}}}
}

export function currentChoice(planning,path,proposal) {
  if(!planning)throw new Error('请启用故事规划以核对本次方案。')
  const current=planning.read(path,'decisions',proposal.document_id)
  const selected=current.selection
  const option=selected?.options_version_id===proposal.options_version_id&&proposal.options.find(o=>o.id===selected.option_id&&o.content===selected.content&&o.title===selected.title)
  return {version:current.version_id,option:option?.id??null,sourceStatus:current.source_status}
}

export function draftFromChoice(planning,path,base,proposal) {
  const choice=currentChoice(planning,path,proposal)
  if(!choice.option||!['current','unbound'].includes(choice.sourceStatus))throw new Error('请先确认本流程生成的一项方向，并核对其来源。')
  return {...base,context:{...base.context,chapter:base.document,direction:{document_id:proposal.document_id,options_version_id:proposal.options_version_id,option_id:choice.option}}}
}


export function choicePreview(planning,path,state,option) {
  const proposal=state.steps[0]?.result?.proposal
  if(state.status!=='awaiting-direction'||!proposal?.options.some(o=>o.id===option))throw new Error('请从本流程待确认的三个方向中选择。')
  const current=currentChoice(planning,path,proposal)
  const change={action:'decision.select',id:proposal.document_id,expected_version_id:current.version,options_version_number:proposal.options_version_number,option_id:option}
  const preview=planning.preview(path,change)
  return {change,planningToken:preview.token,token:hash({state,change,planningToken:preview.token}),selection:preview.value.after.selection}
}
