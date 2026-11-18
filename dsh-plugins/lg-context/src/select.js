import { hash } from './policy.js'
import { notes } from './notes.js'
const record = (kind, item, label) => ({ kind, id: item.id, label, text: JSON.stringify(item), identity: { id: item.id }, sourceHash: hash(item) })
export function select(books, memory, path, options, planning) {
  const items = [], warnings = []
  if(options.story){
    if(!books.storyTime)throw Error('当前作品服务尚未加载故事时点查询')
    const view=books.storyTime(path,{...options.story,include_candidates:false})
    const state=view.character
    if(!state)throw Error('人物时点查询缺失')
    const entries=options.audience==='character'?state.certain.filter(r=>r.type==='knowledge'&&r.payload.holder===options.story.subject):[...state.certain,...state.uncertain]
    for(const r of entries){
      const uncertain=state.uncertain.some(x=>x.id===r.id)
      items.push({kind:'story-state',id:r.id,label:(uncertain?'时间不确定／不可认定当前有效':'此事件位置适用')+' · '+r.title,
        text:JSON.stringify({type:r.type,payload:r.payload,basis:r.basis,certainty:uncertain?'uncertain':'applicable'}),
        identity:{revision:r.revision,query:options.story,projection:view.revision},sourceHash:hash(r)})
    }
    warnings.push(...state.warnings)
    if(state.uncertain.length)warnings.push('部分状态时间未确定；人物视图不注入不确定认知。')
    if(state.conflicts.length)warnings.push('存在尚未解决的状态冲突，不能自动选择一个结论。')
    // Include a non-content receipt even for an empty result, so newly confirmed knowledge invalidates it.
    items.push({kind:'story-query',id:options.story.subject,label:'查询覆盖说明',text:'仅使用作者确认且来源有效的记录；未登记不表示不知道。',identity:{query:options.story,projection:view.revision},sourceHash:hash(view.revision)})
    if(options.audience==='character')return {items,warnings}
  }
  if (options.audience !== 'author') {
    const view = memory.view(path, { audience: options.audience, position: options.position,
      holder_document_id: options.holder_document_id, limit: 100 })
    for (const value of view.statements) items.push({ kind: 'cognition', id: value.record_id, label: `${value.stance} · ${value.topic.key}`,
      text: value.content, identity: { proposal: value.proposal_version_id, topic: value.topic, sources: value.sources }, sourceHash: hash(value) })
    if (view.truncated || view.withheld.length || view.invalid) warnings.push('部分认知因预算、记录或来源状态未纳入。')
    return { items, warnings }
  }
  if(options.previousChapter){
    const {document,version}=options.previousChapter
    const row=books.readState(path,db=>db.prepare(`SELECT d.title,v.content FROM documents d
      JOIN document_versions v ON v.document_id=d.id AND v.id=d.active_version_id
      WHERE d.kind='chapter' AND d.id=? AND v.id=? AND d.state IN ('accepted','final')
      AND v.state IN ('accepted','final') AND length(v.content)<=400000`).get(document,version))
    if(!row?.content.trim())throw new Error('前章已采用的正文或版本已变化。')
    items.push({kind:'chapter-ending',id:document,label:row.title+' · 已采用章末',text:row.content,identity:{version},sourceHash:hash(row.content)})
  }
  items.push(...books.readState(path, db => options.documents.map(id => {
    const value = db.prepare(`SELECT d.id,d.title,d.kind,d.state,d.active_version_id,v.state AS version_state,
      length(v.content) AS size,substr(v.content,1,400001) AS content FROM documents d
      JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.id=?`).get(id)
    if (!value || ['archived', 'rejected'].includes(value.state) || ['archived', 'rejected'].includes(value.version_state) ||
      ['creative_decision', 'narrative_knowledge'].includes(value.kind) || value.size > 400000) throw new Error('上下文文档不存在、状态无效或需要专用方案／认知接口。')
    return { kind: 'document', id, label: `${value.title} · ${value.kind} · ${value.state}（辅助材料）`, text: value.content,
      identity: { version: value.active_version_id, state: value.state, versionState: value.version_state }, sourceHash: hash(value) }
  })))
  if (options.facts) {
    const world = memory.world(path, 30)
    items.push(...world.facts.map(item => record('fact', item, '作者确认的世界事实；不代表人物已知')))
    if (world.truncated) warnings.push('正式事实仅纳入有界子集。')
  }
  for (const [enabled, section, filter, label] of [
    [options.ideas, 'facts', { state: 'idea' }, '设想／未确认'],
    [options.timeline, 'timeline', { state: 'canonical' }, '作者确认时间线；旧记录未绑定精确正文版本'],
    [options.foreshadowing, 'foreshadowing', {}, '伏笔计划／非人物知识'],
  ]) {
    if (!enabled) continue
    const page = memory.list(path, section, { ...filter, limit: 30 })
    items.push(...page.items.filter(item => !item.error && (section !== 'foreshadowing' || ['open', 'planned'].includes(item.state)))
      .map(item => record(section === 'facts' ? 'idea' : section, item, label)))
    if (page.nextOffset !== null || page.truncated) warnings.push(`${section} 仅纳入有界子集。`)
  }
  if (options.decisions || options.direction || options.scene) {
    if (!planning) throw new Error('请先启用 lg-planning 以读取方向或场景计划。')
    if (options.decisions || options.direction) {
      const pin=options.direction
      const directions = planning.context(path, { chapter_id: options.chapter, limit: 30,...(pin?{decision_id:pin.document_id}:{}) })
      if(pin&&!directions.items.some(item=>item.document_id===pin.document_id&&item.selection.option_id===pin.option_id&&item.selection.options_version_id===pin.options_version_id&&['current','unbound'].includes(item.source_status)))
        throw new Error('所选方向已变化、来源已失效或不适用于目标章。')
      for (const item of directions.items) {
        if(pin&&item.document_id!==pin.document_id)continue
        if (!['current', 'unbound'].includes(item.source_status)) { warnings.push('已排除来源失效的创作方向。'); continue }
        const source={ kind: 'decision', id: item.document_id, label: '作者选定方向／创作约束，非世界事实'+(pin?' · '+item.selection.title:''), text: item.selection.content,
          identity: { topic: item.topic, options_version_id: item.selection.options_version_id, option_id: item.selection.option_id }, sourceHash: hash(item) }
        if(pin)items.unshift(source)
        else items.push(source)
      }
      if (directions.truncated || directions.invalid) warnings.push('方向上下文存在截断或无效记录。')
    }
    if (options.scene) {
      const item = planning.read(path, 'scenes', options.scene)
      const visible = Object.fromEntries(['document_id', 'title', 'chapter_id', 'sequence', 'active_version_id', 'pov', 'narrative_tense', 'time_label', 'location', 'goal', 'characters', 'conflict', 'required_information', 'emotional_change', 'end_state', 'word_min', 'word_max', 'plan', 'plan_state'].map(key => [key, item[key]]))
      items.push({ kind: 'scene', id: item.document_id, label: `场景设计 · ${item.plan_state}；不含待审替换计划`, text: JSON.stringify(visible),
        identity: { document_id: item.document_id, active_version_id: item.active_version_id }, sourceHash: hash(visible) })
    }
  }
  if (options.notes) { const selected = notes(path); items.push(...selected.items); warnings.push(...selected.warnings) }
  return { items, warnings }
}
