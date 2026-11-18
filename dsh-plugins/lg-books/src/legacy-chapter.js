import {compactFingerprint} from './analysis-snapshot.js'
import {hash} from './chapter-file-format.js'
import {version} from './manuscript.js'

const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value)
const ownsLegacy=(meta)=>meta.literary_task_policy==='lg.literary-task.v1'

/** Validate the two observations written by the old bounded chapter task before activation. */
export function legacyChapter(db,doc,v,readDecision){
  const m=v.metadata,r=m.generation_sources
  if(!ownsLegacy(m)||doc.kind!=='chapter'||['schema','generation','source_version_id','restored_from_version','legacy_parent'].some(k=>m[k]!==undefined)||
     r?.schema!=='lg.generation-sources.v1'||r.mode!=='literary-task'||r.stage_id!=='chapter'||
     typeof m.run_id!=='string'||!m.run_id||r.run_id!==m.run_id||r.coverage!=='partial'||
     !sha(r.input?.prompt_sha256)||!sha(r.input?.instructions_sha256)||!Array.isArray(r.observations)||
     !Array.isArray(r.unknown_reasons)||!r.unknown_reasons.every(s=>typeof s==='string'))
    throw new Error('此候选的旧审批规则尚未迁移，或生成收据无效。')
  if(m.base_version_id!==doc.active_version_id)throw new Error('旧候选所依据的正文版本已变化。')
  if(m.generation_output_sha256!==hash(v.content))throw new Error('旧候选正文与生成时的摘要不符。')
  const required=m.required_decision,observations=r.observations
  if(observations.length!==(required===undefined?1:2)||observations.some(o=>o?.coverage!=='partial'||!sha(o.payload_sha256)||!Array.isArray(o.refs)||o.refs.length!==1))
    throw new Error('旧章节的来源记录不完整或含有不支持的来源。')
  const source=observations[0],ref=source.refs[0]
  if(source.tool!=='read_document'||ref?.kind!=='document'||ref.exposure!=='content'||ref.document_id!==doc.id||
     ref.version_id!==doc.active_version_id||source.payload_sha256!==compactFingerprint({id:doc.id,active_version_id:doc.active_version_id,content:doc.content,state:doc.state}))
    throw new Error('旧候选读取的原章内容或状态已变化。')
  const proof={run:m.run_id,document:doc.id,base:m.base_version_id,version:v.id,output:m.generation_output_sha256,receipt:compactFingerprint(r)}
  if(required!==undefined){
    const o=observations[1],choice=o.refs[0]
    if(!required||Object.keys(required).sort().join()!=='document_id,selection_sha256'||!Number.isSafeInteger(required.document_id)||required.document_id<1||
       o.tool!=='studio_decision'||choice?.kind!=='creative_decision'||choice.exposure!=='selected'||choice.document_id!==required.document_id)
      throw new Error('旧候选的方向绑定无效。')
    if(!readDecision)throw new Error('请启用 lg-planning 核对旧候选的作者选择。')
    const d=readDecision(db,choice.document_id),s=d.selection
    const semantic={topic:d.topic,status:d.status,selection:s,source_status:d.source_status,source_details:d.source_details.map(({sha256,...detail})=>detail)}
    if(!s||!['current','unbound'].includes(d.source_status)||compactFingerprint(s)!==required.selection_sha256||
       choice.option_id!==s.option_id||choice.options_version_id!==s.options_version_id||choice.selection_sha256!==compactFingerprint(semantic))
      throw new Error('旧候选的作者选择或方向来源已变化，请重新核对。')
    proof.direction={document:d.document_id,optionsVersion:s.options_version_id,option:s.option_id,title:s.title,content:s.content,selectionDigest:required.selection_sha256}
  }
  return proof
}

export function candidateLineage(db,doc,selected,token,readDecision){
  const native=[]
  let current=selected,legacy=null
  while(true){
    if(native.length>=32)throw new Error('候选来源链过长，请先整理版本。')
    const m=current.metadata
    if(m.schema!=='lg.candidate.v1'||m.literary_task_policy!==undefined){legacy=legacyChapter(db,doc,current,readDecision);break}
    if(m.base_version_id!==doc.active_version_id||m.chapter_token!==token)throw new Error('候选来源已经变化，请基于最新正文重新修订。')
    if(m.generation_sources!==undefined||m.generation_output_sha256!==undefined||m.required_decision!==undefined&&!m.legacy_parent)
      throw new Error('候选来源的审批规则或正文已变化。')
    native.push(current)
    if(m.source_version_id==null||m.source_version_id===doc.active_version_id)break
    current=version(db,doc.id,m.source_version_id)
    if(current.state==='rejected')throw new Error('改稿来源候选已被拒绝。')
    if(current.state!=='candidate')break
  }
  const inherited=legacy?.direction?{document_id:legacy.direction.document,selection_sha256:legacy.direction.selectionDigest}:null
  for(const v of native){
    const m=v.metadata
    if(m.legacy_parent!==undefined&&(!legacy||m.legacy_parent!==compactFingerprint(legacy)||compactFingerprint(m.required_decision??null)!==compactFingerprint(inherited)))
      throw new Error('改稿的旧候选来源或作者选择已变化。')
  }
  return {native,legacy,inherited}
}
