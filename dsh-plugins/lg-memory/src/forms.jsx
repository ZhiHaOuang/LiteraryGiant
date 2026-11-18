import React, { useState } from 'react'

export const labels = { 'fact.add': '新增世界设定', 'fact.set': '更新同分类与键的设定', 'fact.propose': '提出事实候选',
  'fact.promote': '确认为正式事实', 'fact.archive': '归档事实', 'proposal.accept': '采用事实提案', 'proposal.reject': '拒绝事实提案',
  'timeline.add': '新增时间事件', 'timeline.update': '修改时间事件', 'foreshadow.add': '登记伏笔', 'foreshadow.resolve': '处理伏笔',
  'knowledge.propose': '提出叙事认知', 'knowledge.confirm': '确认指定认知提案', 'knowledge.withdraw': '撤回当前认知确认' }
export const stateLabels = { idea: '设想', canonical: '作者确认', archived: '归档', rejected: '拒绝', proposed: '待审', accepted: '已采用',
  open: '待回收', planned: '计划埋设', paid: '已回收', abandoned: '放弃', unconfirmed: '未确认', confirmed: '已确认', withdrawn: '已撤回',
  current: '当前已采用来源', pending: '来源未采用', stale: '来源已更新', unavailable: '来源不可用', unbound: '独立设定，无正文来源',
  knows: '知道', believes: '相信（可以有误）', uncertain: '不确定' }
export function initial(section) {
  if (['facts', 'proposals'].includes(section)) return { action: section === 'facts' ? 'fact.add' : 'fact.propose', category: 'world', key: '', value: '', rationale: '', state: 'idea', tags: [] }
  if (section === 'timeline') return { action: 'timeline.add', label: '', event: '', sort_key: '', state: 'idea', tags: [] }
  if (section === 'foreshadowing') return { action: 'foreshadow.add', title: '', setup_note: '', state: 'planned', tags: [] }
  return { action: 'knowledge.propose', slug: '', title: '', expected_version_id: 0,
    topic: { audience: 'character', holder_document_id: null, key: '', from_position: 0 },
    statement: { content: '', stance: 'believes', until_position: null, sources: [] }, rationale: '' }
}
function Source({ value, onChange, documents }) {
  return <div className="lgm-row"><label>来源文档<select value={value.source_document_id ?? ''} onChange={event => {
    const doc = documents.find(doc => doc.id === Number(event.target.value))
    onChange({ source_document_id: doc?.id ?? null, source_version_id: doc?.active_version_id ?? null })
  }}><option value="">独立设定，不绑定正文</option>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title} · {doc.state}</option>)}</select></label>
    {value.source_document_id && <label>精确版本 ID<input type="number" min="1" value={value.source_version_id ?? ''}
      onChange={event => onChange({ ...value, source_version_id: Number(event.target.value) })}/></label>}</div>
}
export function MemoryForm({ initialValue, documents, onPreview, onCancel, busy }) {
  const [value, setValue] = useState(initialValue), [pendingSource, setPendingSource] = useState({}), [tagText, setTagText] = useState((initialValue.tags ?? []).join(', '))
  const set = patch => setValue(current => ({ ...current, ...patch })), action = value.action
  const field = (key, label, options = {}) => <label key={key}>{label}{options.values ? <select value={value[key] ?? ''}
    onChange={event => set({ [key]: event.target.value })}>{options.values.map(item => <option key={item} value={item}>{stateLabels[item] ?? item}</option>)}</select>
    : options.long ? <textarea value={value[key] ?? ''} maxLength={options.max ?? 12000} required onChange={event => set({ [key]: event.target.value })}/>
      : <input value={value[key] ?? ''} type={options.number ? 'number' : 'text'} maxLength={options.max ?? 200} required={!options.optional}
        onChange={event => set({ [key]: options.number ? Number(event.target.value) : event.target.value })}/>}</label>
  const knowledge = action === 'knowledge.propose', fact = ['fact.add', 'fact.set', 'fact.propose'].includes(action)
  return <form onSubmit={event => { event.preventDefault(); onPreview(value) }}><fieldset disabled={busy}><legend>{labels[action]}</legend>
    {fact && <>{field('category', '分类')}{field('key', '事实键')}{field('value', '内容', { long: true })}
      {action !== 'fact.propose' && field('state', '保存状态', { values: ['idea', 'canonical', 'archived', 'rejected'] })}
      <Source value={value} onChange={set} documents={documents}/></>}
    {['timeline.add', 'timeline.update'].includes(action) && <>{field('label', '时间标签')}{field('sort_key', '排序键（由作者定义）', { optional: true })}
      {field('event', '事件', { long: true })}{field('state', '状态', { values: ['idea', 'canonical', 'archived', 'rejected'] })}
      <label>关联文档<select value={value.source_document_id ?? ''} onChange={event => set({ source_document_id: Number(event.target.value) || null })}>
        <option value="">无</option>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label></>}
    {action === 'foreshadow.add' && <>{field('title', '伏笔标题')}{field('setup_note', '埋设说明', { long: true })}{field('state', '状态', { values: ['planned', 'open'] })}</>}
    {action === 'foreshadow.resolve' && <>{field('payoff_note', '回收或放弃说明', { long: true })}{field('state', '处理结果', { values: ['paid', 'abandoned'] })}</>}
    {action.startsWith('foreshadow.') && <label>{action === 'foreshadow.add' ? '埋设文档' : '回收文档'}<select
      value={value[action === 'foreshadow.add' ? 'setup_document_id' : 'payoff_document_id'] ?? ''} onChange={event => set({ [action === 'foreshadow.add' ? 'setup_document_id' : 'payoff_document_id']: Number(event.target.value) || null })}>
      <option value="">无</option>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
    {knowledge && <>{field('slug', '固定标识（文字、数字或连字符）')}{field('title', '认知标题')}
      <label>认知主体<select value={value.topic.audience} onChange={event => set({ topic: { ...value.topic, audience: event.target.value, holder_document_id: null } })}>
        <option value="character">人物</option><option value="reader">读者</option></select></label>
      {value.topic.audience === 'character' && <label>人物<select required value={value.topic.holder_document_id ?? ''} onChange={event => set({ topic: { ...value.topic, holder_document_id: Number(event.target.value) } })}>
        <option value="">选择人物</option>{documents.filter(doc => doc.kind === 'character').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
      <label>主题键<input required value={value.topic.key} maxLength={128} onChange={event => set({ topic: { ...value.topic, key: event.target.value } })}/></label>
      <div className="lgm-row"><label>{value.topic.audience === 'character' ? '故事位置起点' : '阅读位置起点'}<input type="number" required value={value.topic.from_position}
        onChange={event => set({ topic: { ...value.topic, from_position: Number(event.target.value) } })}/></label>
        <label>结束位置（不含；留空表示持续）<input type="number" value={value.statement.until_position ?? ''} onChange={event => set({ statement: { ...value.statement, until_position: event.target.value === '' ? null : Number(event.target.value) } })}/></label></div>
      <label>认知内容<textarea required maxLength={12000} value={value.statement.content} onChange={event => set({ statement: { ...value.statement, content: event.target.value } })}/></label>
      <label>认识状态<select value={value.statement.stance} onChange={event => set({ statement: { ...value.statement, stance: event.target.value } })}>
        {['knows', 'believes', 'uncertain'].map(stance => <option key={stance} value={stance}>{stateLabels[stance]}</option>)}</select></label>
      <Source value={pendingSource} onChange={setPendingSource} documents={documents}/>
      <button type="button" disabled={!pendingSource.source_document_id || value.statement.sources.length >= 32} onClick={() => {
        const source = { document_id: pendingSource.source_document_id, version_id: pendingSource.source_version_id }
        if (!value.statement.sources.some(item => item.document_id === source.document_id && item.version_id === source.version_id)) set({ statement: { ...value.statement, sources: [...value.statement.sources, source] } })
      }}>加入来源</button>
      {value.statement.sources.map((source, index) => <p key={index}>文档 {source.document_id} · 版本 ID {source.version_id} <button type="button"
        onClick={() => set({ statement: { ...value.statement, sources: value.statement.sources.filter((_, i) => i !== index) } })}>移除</button></p>)}
    </>}
    {action === 'knowledge.confirm' && field('proposal_version_number', '要确认的提案版本号', { number: true })}
    {action === 'knowledge.withdraw' && <p>只撤回当前确认，保留提案和历史；不会回退到旧确认。</p>}
    {(fact || knowledge || action.startsWith('proposal.') || ['fact.promote', 'fact.archive'].includes(action)) && field('rationale', '依据或处理理由', { long: true, max: 4000 })}
    {(fact || action.startsWith('timeline.') || action === 'foreshadow.add') && <label>标签（用逗号分隔）<input value={tagText}
      onChange={event => { setTagText(event.target.value); set({ tags: event.target.value.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean) }) }}/></label>}
    <div className="lgm-row"><button type="submit">预览变更</button><button type="button" onClick={onCancel}>取消</button></div>
  </fieldset></form>
}
