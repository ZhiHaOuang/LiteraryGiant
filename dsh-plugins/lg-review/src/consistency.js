import { hash } from './targets.js'

const live = "d.state NOT IN ('archived','rejected','candidate')"
const accepted = state => ['accepted','final'].includes(state)
const excerpt = value => {
  const text=String(value);let end=Math.min(500,text.length)
  if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1])&&/[\uDC00-\uDFFF]/u.test(text[end]))end--
  return text.slice(0,end)
}
const evidence = (section,id,quote,extra={}) => ({label:section,kind:'target',quote:excerpt(quote),anchor:{section,id,...extra}})
const groupBy = (items,key) => {const groups=new Map();for(const item of items){const id=key(item);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(item)}return groups}
function bounded(db,sql,params=[]) {
  const rows=db.prepare(sql+' LIMIT 1001').all(...params)
  if(rows.length>1000 || JSON.stringify(rows).length>4000000)throw new Error('一致性检查超过单类 1000 条或 400 万字符上限，请缩小检查范围或先整理记录。')
  return rows
}
export function consistencySnapshot(books,path,target) {
  if(!target || target.section!=='consistency' || !Number.isSafeInteger(target.id) || target.id<0 || Object.keys(target).some(key=>!['section','id'].includes(key)))throw new Error('一致性检查目标无效；0 表示全书，否则选择章节或场景。')
  return books.readState(path,db=>{
    if(target.id){const doc=db.prepare(`SELECT kind FROM documents d WHERE d.id=? AND ${live}`).get(target.id);if(!doc||!['chapter','scene'].includes(doc.kind))throw new Error('请选择有效章节或场景。')}
    const documents=bounded(db,`SELECT d.id,d.title,d.kind,d.state,d.parent_id,d.active_version_id,v.content,v.state AS version_state FROM documents d LEFT JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE ${live} AND d.kind IN ('chapter','scene')${target.id?' AND (d.id=? OR (d.parent_id=? AND d.kind=\'scene\'))':''} ORDER BY d.id`,target.id?[target.id,target.id]:[])
    if(documents.some(doc=>doc.content===null))throw new Error('正文版本引用损坏，请先修复作品。')
    const facts=bounded(db,`SELECT f.*,d.state AS source_document_state,d.active_version_id,v.document_id AS version_document_id,v.state AS source_version_state FROM story_facts f LEFT JOIN documents d ON d.id=f.source_document_id LEFT JOIN document_versions v ON v.id=f.source_version_id WHERE f.state='canonical' ORDER BY f.id`)
    const scenes=bounded(db,`SELECT s.* FROM scene_cards s JOIN documents d ON d.id=s.document_id WHERE ${live}${target.id?' AND (d.id=? OR d.parent_id=?)':''} ORDER BY s.document_id`,target.id?[target.id,target.id]:[])
    const timeline=bounded(db,"SELECT * FROM timeline_entries WHERE state='canonical' ORDER BY id")
    const foreshadowing=target.id?[]:bounded(db,"SELECT * FROM foreshadowing WHERE state IN ('open','planned') ORDER BY id")
    const issues=[]
    const add=(severity,category,message,proof,suggestion)=>{
      if(issues.length>=100)throw new Error('检查发现超过 100 条提示，请缩小范围或先处理现有记录。未保存不完整报告。')
      issues.push({severity,category,message,evidence:proof.slice(0,10),suggestion})
    }
    const current=[]
    for(const fact of facts){
      const unbound=fact.source_document_id===null&&fact.source_version_id===null
      const valid=unbound || fact.source_document_id===fact.version_document_id && fact.source_version_id===fact.active_version_id && accepted(fact.source_document_state) && accepted(fact.source_version_state)
      if(valid)current.push(fact)
      else add('warning','fact-source',`正式事实 ${fact.id} 的来源未采用、已过期或不可用；不将它作为当前事实判断冲突。`,[evidence('facts',fact.id,`${fact.category}/${fact.fact_key} = ${fact.value}`,{document:fact.source_document_id,version:fact.source_version_id})],'在故事记忆面板核对来源，再由作者修订或归档事实。')
    }
    for(const items of groupBy(current,f=>JSON.stringify([f.category.toLowerCase(),f.fact_key.toLowerCase()])).values()){
      if(new Set(items.map(f=>f.value.trim())).size<2)continue
      add('warning','canonical-conflict',`同一事实键 ${items[0].category}/${items[0].fact_key} 有 ${items.length} 条正式记录且取值不同，需核对适用范围。`,items.map(f=>evidence('facts',f.id,f.value,{document:f.source_document_id,version:f.source_version_id})),`核对是否描述不同时期或条件；不要让模型自行选择。证据最多列前 10 条。`)
    }
    for(const scene of scenes){
      const doc=documents.find(item=>item.id===scene.document_id)
      if(!doc || scene.chapter_id!==doc.parent_id) {add('error','scene-identity',`场景 ${scene.document_id} 的章节关联不一致。`,[evidence('scenes',scene.document_id,`card.chapter=${scene.chapter_id}; document.parent=${doc?.parent_id??'missing'}`)],'在故事规划中核对场景所属章节。');continue}
      if(['approved','drafted','reviewed'].includes(scene.status) && (!scene.plan.trim() || scene.plan_state!=='approved'))add('warning','scene-plan',`场景 ${doc.title} 已标记 ${scene.status}，但缺少已批准的非空计划。`,[evidence('scenes',doc.id,`status=${scene.status}; plan_state=${scene.plan_state}; plan=${scene.plan}`,{document:doc.id,version:doc.active_version_id})],'核对是作者直接写作还是计划遗漏；需要计划时在故事规划面板批准。')
      if(accepted(doc.state)&&accepted(doc.version_state)){
        const count=books.wordCount(doc.content)
        if(scene.word_min!==null&&count<scene.word_min || scene.word_max!==null&&count>scene.word_max)add('warning','scene-length',`场景 ${doc.title} 的已采用正文 ${count} 字，超出场景卡范围 ${scene.word_min??0}–${scene.word_max??'不限'}。`,[evidence('scenes',doc.id,`word_count=${count}; min=${scene.word_min}; max=${scene.word_max}`,{document:doc.id,version:doc.active_version_id})],'确认是否刻意采用短／长场景，或调整正文和场景卡字数要求。')
      }
    }
    const needles=[]
    for(const fact of current){
      if(['forbidden','do-not-change','constraint'].includes(fact.category.toLowerCase())&&[...fact.value.trim()].length>=3)needles.push({fact,term:fact.value.trim(),category:'forbidden-content',insensitive:true})
      if(['character','character-status'].includes(fact.category.toLowerCase())){
        let tags;try{tags=JSON.parse(fact.tags_json);if(!Array.isArray(tags))throw new Error()}catch{throw new Error(`事实 ${fact.id} 标签格式无效，请先修复。`)}
        if(['dead','deceased','missing','absent','离场','死亡','失踪'].includes(fact.value.toLowerCase())||tags.some(tag=>['dead','deceased'].includes(String(tag).toLowerCase())))if(fact.fact_key)needles.push({fact,term:fact.fact_key,category:'character-availability'})
      }
    }
    if(documents.reduce((n,d)=>n+d.content.length,0)*needles.length>20000000)throw new Error('正文与约束的匹配量超过本次检查上限，请按章节检查。')
    for(const doc of documents)for(const {fact,term,category,insensitive} of needles){
      const escaped=term.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),match=new RegExp(escaped,insensitive?'iu':'u').exec(doc.content)
      if(!match)continue
      const quote=excerpt(match[0])
      add('info',category,category==='forbidden-content'?`${doc.title} 出现约束 ${fact.fact_key} 的字面内容，需核对语境。`:`${doc.title} 提到状态为 ${fact.value} 的人物 ${fact.fact_key}。`,[evidence('facts',fact.id,`${fact.category}/${fact.fact_key} = ${fact.value}`),evidence('manuscript',doc.id,quote,{document:doc.id,version:doc.active_version_id,start:match.index,end:match.index+quote.length})],'仅为字面提示，不证明违约或人物复活；请检查回忆、转述、否定及故事时间。每份正文列第一处命中。')
    }
    for(const [key,items] of groupBy(timeline.filter(item=>item.sort_key),item=>item.sort_key))if(new Set(items.map(item=>item.event.trim())).size>1)add('info','timeline',`时间排序键 ${key} 对应 ${items.length} 条不同事件；同时发生也可能合理。`,items.map(item=>evidence('timeline',item.id,item.event,{document:item.source_document_id})),'核对是否同时发生；必要时在故事记忆面板调整排序键。证据最多列前 10 条。')
    if(foreshadowing.length>12)add('info','foreshadowing',`当前有 ${foreshadowing.length} 条未回收伏笔；数量本身不代表错误。`,foreshadowing.map(item=>evidence('foreshadowing',item.id,item.title,{document:item.setup_document_id})),'在后续规划时选择继续、回收或放弃。证据最多列前 10 条。')
    const summary={documents:documents.length,facts:facts.length,currentFacts:current.length,scenes:scenes.length,timeline:timeline.length,openForeshadowing:target.id?null:foreshadowing.length,scope:target.id?'selected-document-and-child-scenes':'whole-book',globalFactsAndTimeline:true}
    return {target,context:{receipt:null},summary,receipt:{schema:'lg.consistency-sources.v1',target,binding:hash({documents,facts,scenes,timeline,foreshadowing})},issues}
  })
}
