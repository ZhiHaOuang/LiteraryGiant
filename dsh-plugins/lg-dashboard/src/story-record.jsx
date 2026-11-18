import React,{useState} from 'react'
import {requestBooks} from './api.js'
import {formatStoryTime} from './temporal-view-model.js'
import {characterRoleView,previousLabel,recordQualifier} from './story-fields.js'

const labels={prominence:'重要程度',roles:'叙事身份',topic:'认知主题',entity_kind:'类别',name:'名称',aliases:'别名',description:'描述',statement:'规则内容',domain:'适用领域',conditions:'成立条件',exceptions:'例外',pov:'视角人物',narrator:'叙述者',location:'地点',participants:'参与者',purpose:'场景作用',opening:'开场状态',ending:'结束状态',actors:'行动者',action:'行动',outcome:'结果',motivation:'动机',scene:'所属场景',subject:'主体',facet:'状态方面',value:'状态内容',previous_record:'此前状态',trigger_event:'触发事件',object:'关系对象',relation:'关系',holder:'认知持有人',proposition:'信息内容',stance:'认知立场',acquired_by:'获知方式',presentation:'呈现方式',speaker:'信息提供者',about_record:'相关记录',question:'未决问题',thread_kind:'线索类别',progress:'进展',setup_records:'铺垫',planned_payoff:'预期回收',actual_payoff:'实际回收',level:'规划层次',parent:'上级规划',objective:'目标',steps:'步骤',expected_changes:'预期变化',constraints:'约束',reveal:'准备揭示',withhold:'继续隐藏',selection:'选择状态',realized_events:'实际对应事件',aspect:'侧写方面',counterevidence:'反例与限制',dimension:'分析维度',assessment:'分析意见',limitations:'局限',about:'相关对象',category:'要求类别',instruction:'要求内容',strength:'强度',targets:'适用对象'}
const terms={core:'核心人物',major:'重要人物',supporting:'配角',minor:'次要人物',protagonist:'主角',antagonist:'对抗者',mentor:'导师',ally:'伙伴',other:'其他角色',simultaneous:'同时',overlaps:'重叠',range:'时间范围',candidate:'候选',confirmed:'作者已确认',rejected:'已拒绝',withdrawn:'已撤回',text:'文本呈现',character_statement:'人物说法',inference:'分析推测',author:'作者设定',current:'来源有效',stale:'来源已变化',invalid:'证据校验失败',unavailable:'来源不可用',character:'人物',group:'势力',place:'地点',object:'物品',concept:'概念',believes:'相信',doubts:'怀疑',denies:'否认',uncertain:'尚未确定',experience:'亲历',told:'被告知',read:'阅读',unknown:'未知',narration:'旁白',statement:'人物陈述',hint:'暗示',correction:'纠正',reveal:'揭晓',conflict:'冲突',mystery:'悬念',foreshadowing:'伏笔',relationship:'关系',goal:'目标',possible:'可能线索',open:'未解决',resolved:'已回收',abandoned:'已放弃',book:'全书',arc:'阶段',chapter:'章节',scene:'场景',option:'备选',selected:'选定',cancelled:'取消',desire:'欲望',value:'价值取向',fear:'恐惧',behavior:'行为倾向',voice:'表达习惯',contradiction:'内在矛盾',growth:'变化',summary:'概括',rhythm:'节奏',emotion:'情绪',style:'文风',theme:'主题',logic:'逻辑',viewpoint:'视角',constraint:'约束',preference:'偏好',must:'必须',prefer:'倾向',before:'先于',causes:'导致',enables:'促成',obstructs:'阻碍',supports:'支持',contradicts:'质疑',reveals:'揭示',pays_off:'回收',part_of:'属于',motivates:'驱动',all:'全时期',relative:'相对时间',interval:'时间区间'}
export const term=v=>terms[v]??v
const categoryLabels={role_assignment:'人物叙事身份',entity:'人物与实体',portrait:'人物性格与侧写',analysis:'情节梗概与分析'}
export const roleLabel=role=>characterRoleView(role).label
function CharacterIdentity({role,onReference,directory}){
 if(!role)return null
 return <div className="lgd-character-identity"><h4>人物重要程度与叙事身份</h4>
  {!role.assignments.length?<p className="lgd-muted">当前阅读范围尚无有效评级记录。</p>:<>
   {role.status==='scoped'&&<p className="lgd-muted">以下身份按各自范围或时间记录，未作为全书等级。</p>}
   {role.status==='conflict'&&<p className="lgd-muted">全书评级存在不同意见，保留各自依据。</p>}
   {role.assignments.map(item=><div key={item.id} className="lgd-identity-assignment"><p><b>{term(item.prominence)}</b> · {item.roles.map(term).join('、')||'身份未指定'} <span className="lgd-badge">{term(item.approval)}</span></p>
    <p>{item.summary}</p><small>{item.scope.description} · {formatStoryTime(item.story_time,directory)}</small><button className="lgd-data-link" onClick={()=>onReference(item.id)}>查看评级依据</button>
   </div>)}
  </>}
 </div>
}
function Value({value,directory,onReference}){
 if(value===null||value==='')return <span className="lgd-muted">未确定／未登记</span>
 if(Array.isArray(value))return value.length?<ul>{value.map((v,i)=><li key={i}><Value value={v} directory={directory} onReference={onReference}/></li>)}</ul>:<span className="lgd-muted">未登记</span>
 if(typeof value==='object')return <dl className="lgd-data-fields">{Object.entries(value).map(([key,item])=><React.Fragment key={key}><dt>{labels[key]??key}</dt><dd><Value value={item} directory={directory} onReference={onReference}/></dd></React.Fragment>)}</dl>
 if(directory[value])return <button className="lgd-data-link" onClick={()=>onReference(value)}>{directory[value].title}</button>
 return <span>{term(String(value))}</span>
}
export function StoryRecord({record:r,path,data,onReference,open,onToggle}){
 const [history,setHistory]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false)
 async function loadHistory(){setLoading(true);setError('');try{setHistory(await requestBooks({action:'story-data-history',path,id:r.id}))}catch(e){setError(e.message)}finally{setLoading(false)}}
 const display=r.display,source=display?.source,identity=characterRoleView(display?.character_role),qualifier=recordQualifier(r)
 return <details className="lgd-data-entry" open={open}><summary onClick={e=>{e.preventDefault();onToggle()}}>
  <span className="lgd-data-chevron" aria-hidden="true">{open?'⌄':'›'}</span>
  <span className="lgd-data-heading"><strong>{display?.title??r.title}</strong><span className="lgd-data-subtitle">
   <span className="lgd-data-kind">{categoryLabels[r.type]??data.catalog?.[r.type]?.label??display?.category}{display?.facet&&` · ${display.facet}`}</span>
   <span>{source?`来源第 ${source.chapter} 章 · 第 ${source.paragraph} 段`:'未定位章节'}</span>
   {display?.source_chapters?.length>1&&<span>来源章节：{display.source_chapters.join('、')}</span>}
   {qualifier&&<span>{qualifier}</span>}
   {r.type==='entity'&&<span>关联 {display?.related_count??0} 条</span>}
   {display?.character_role&&<span className="lgd-role-level">{identity.label}{identity.detail&&` · ${identity.detail}`}</span>}
   {identity.scope&&<span>{identity.scope}</span>}
  </span></span>
  <span className="lgd-data-tags"><span className="lgd-badge">{term(r.basis)}</span><span className="lgd-badge">{term(r.approval)}</span>{r.freshness!=='current'&&<span className="lgd-pending-badge">{term(r.freshness)}</span>}</span>
 </summary>
  {display?.title!==r.title&&<p className="lgd-muted">原始标题：{r.title}</p>}
  <p>{r.summary}</p>
  <CharacterIdentity role={display?.character_role} onReference={onReference} directory={data.directory}/>
  {display?.reader_visibility&&<p className="lgd-muted">读者揭露：{display.reader_visibility.state==='revealed'?'已有明确揭露记录':'尚未标记'} {display.reader_visibility.revelations.map(item=><button key={item.id} className="lgd-data-link" onClick={()=>onReference(item.id)}>查看{item.presentation==='hint'?'暗示':'揭露'}依据 · {term(item.approval)}</button>)}</p>}
  <dl className="lgd-data-fields">{Object.entries(r.payload).map(([k,v])=><React.Fragment key={k}><dt>{k==='previous_record'?previousLabel(r.type):labels[k]??k}</dt><dd>{k==='topic'?<span>{v||'未登记'}</span>:<Value value={v} directory={data.directory} onReference={onReference}/>}</dd></React.Fragment>)}</dl>
  <div className="lgd-data-context"><span>适用范围：{r.scope.description}</span><span>故事时间：{formatStoryTime(r.story_time,data.directory)}</span>
   {r.story_time.offset?.anchor_event&&<span>参照事件：<Value value={r.story_time.offset.anchor_event} directory={data.directory} onReference={onReference}/></span>}
   {r.story_time.after_event&&<span>开始事件：<Value value={r.story_time.after_event} directory={data.directory} onReference={onReference}/></span>}
   {r.story_time.before_event&&<span>结束事件：<Value value={r.story_time.before_event} directory={data.directory} onReference={onReference}/></span>}</div>
  {r.links.length>0&&<div className="lgd-data-links">{r.links.map((l,i)=><p key={i}>{term(l.relation)} <Value value={l.target} directory={data.directory} onReference={onReference}/>：{l.explanation}</p>)}</div>}
  {!!r.related_changed.length&&<p className="lgd-muted">关联记录已有变化，需复核：{r.related_changed.map(id=>data.directory[id]?.title??id).join('、')}</p>}
  {r.confirmed_revision&&r.approval==='candidate'&&<p className="lgd-muted">此候选尚未替代此前作者确认的版本。</p>}
  <details className="lgd-data-evidence"><summary>原文依据 · {r.evidence.length} 处</summary>{r.evidence.map((e,i)=><blockquote key={i}><p>{e.quote}</p><cite>{data.chapters.find(c=>c.id===e.document_id)?.title??'正文'} · 第 {e.paragraph} 段 · 版本 {e.version_id}</cite></blockquote>)}{r.author_note&&<p>作者依据：{r.author_note}</p>}<small>{r.freshness==='current'?'引文位置已校验；解释是否成立仍需审阅。':'来源已变化或不可用，请重新核对引文与解释。'}</small></details>
  <button className="lgd-data-history" disabled={loading} onClick={loadHistory}>{loading?'读取中…':'查看修订历史'}</button>
  {error&&<p role="alert">{error}</p>}{history&&<ol className="lgd-data-revisions">{history.map(h=><li key={h.revision}>{term(h.approval)} · {new Date(h.created_at).toLocaleString()}<p>{h.record.summary}</p></li>)}</ol>}
 </details>
}
