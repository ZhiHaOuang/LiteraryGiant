import Ajv from 'ajv/dist/2020.js'
import {createHash} from 'node:crypto'
import schema from './contract.json' with {type:'json'}
import legacySchema from './contract-v1.json' with {type:'json'}
import {verifyTemporalGraph} from './temporal.js'

export const VERSION='1.1.0'
export const canonical=value=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):value)
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex')
export const contractHash=digest(schema)
export const legacyContractHash=digest(legacySchema)
export const supportedContracts={'1.0.0':legacyContractHash,[VERSION]:contractHash}
const validators=new Map([legacySchema,schema].map(s=>[s.properties.schema_version.const,new Ajv({allErrors:true,strict:false}).compile(s)]))
export const paragraphs=text=>text.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean)
export function validateRecord(record) {
  const validate=validators.get(record?.schema_version)
  if(!validate)throw Error('不支持的故事记录版本')
  if(!validate(record))throw Error('故事记录格式错误：'+validate.errors.slice(0,6).map(e=>e.instancePath+' '+e.message).join('；'))
  if(record.basis==='author'?!record.author_note.trim():record.evidence.length===0)throw Error('记录需要正文证据或作者依据')
  if(['plan','requirement'].includes(record.type)&&record.basis!=='author')throw Error('作者规划与要求不能从正文推测生成')
  if(['all','unknown'].includes(record.story_time.kind)&&(record.story_time.after_event||record.story_time.before_event))throw Error('全时期／未知时间不能含事件边界')
  if(record.story_time.kind==='relative'&&!record.story_time.after_event&&!record.story_time.before_event&&!record.story_time.offset)throw Error('相对时间需要事件边界')
  if(record.story_time.kind==='interval'&&(!record.story_time.after_event||!record.story_time.before_event))throw Error('区间时间需要两个事件边界')
  if(record.story_time.after_event&&record.story_time.after_event===record.story_time.before_event)throw Error('故事时间区间不能为空')
  if(record.type==='thread'&&record.payload.progress==='resolved'&&!record.payload.actual_payoff.length)throw Error('已回收线索需要实际回收记录')
  if(record.type==='revelation'&&!record.evidence.length)throw Error('读者揭示需要正文位置')
  const time=record.story_time
  if(time.kind==='range'&&!time.coordinate)throw Error('时间范围需要坐标')
  if(time.coordinate&&time.kind!=='range')throw Error('时间坐标只能用于范围类型')
  if(time.offset&&time.kind!=='relative')throw Error('时间偏移只能用于相对时间')
  if(record.type==='knowledge'&&record.payload.previous_record&&!record.payload.topic)throw Error('认知前序需要稳定主题')
  return record
}
export function references(r) {
  const refs=[...r.scope.targets.map(id=>[id,null]),...r.links.map(l=>[l.target,null])]
  for(const k of ['after_event','before_event'])if(r.story_time[k])refs.push([r.story_time[k],'event'])
  if(r.story_time.offset)refs.push([r.story_time.offset.anchor_event,'event'])
  const p=r.payload,fields={scene:{pov:'entity',location:'entity',participants:'entity'},event:{actors:'entity',location:'entity',scene:'scene'},state:{subject:'entity',previous_record:'state',trigger_event:'event'},relation:{subject:'entity',object:'entity',trigger_event:'event',previous_record:'relation'},knowledge:{holder:'entity',trigger_event:'event',previous_record:'knowledge'},role_assignment:{subject:'entity'},revelation:{speaker:'entity',about_record:null},thread:{setup_records:null,actual_payoff:null},plan:{parent:'plan',realized_events:'event'},portrait:{subject:'entity'},analysis:{about:null},requirement:{targets:null}}[r.type]??{}
  for(const [key,type] of Object.entries(fields))for(const id of Array.isArray(p[key])?p[key]:p[key]?[p[key]]:[])refs.push([id,type])
  return refs
}
export function verifyGraph(records) {
  const byId=new Map(records.map(r=>[r.id,r]))
  for(const r of records)for(const link of r.links)if(link.relation==='before'&&(r.type!=='event'||byId.get(link.target)?.type!=='event'))throw Error('先后关系只连接实际事件记录')
  for(const r of records)for(const [id,type] of references(r)) {
    const target=byId.get(id)
    if(!target||type&&target.type!==type)throw Error(`${r.id} 引用不存在或类型不符：${id}`)
    if(['holder','pov',...(r.type==='role_assignment'?['subject']:[])].some(k=>r.payload[k]===id)&&target.payload.entity_kind!=='character')throw Error('认知持有人和视角必须引用人物')
  }
  verifyTemporalGraph(records)
}
export function sourceState(db,source) {
  const row=db.prepare('SELECT v.content,v.document_id,d.active_version_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?').get(source.version_id)
  if(!row||row.document_id!==source.document_id)return 'unavailable'
  if(digest(row.content)!==source.sha256||!paragraphs(row.content)[source.paragraph-1]?.includes(source.quote))return 'invalid'
  return row.active_version_id===source.version_id?'current':'stale'
}
export function verifyEvidence(db,r) {
  for(const e of r.evidence)if(sourceState(db,e)!=='current')throw Error('原文证据无效或已过期：'+r.id)
}
