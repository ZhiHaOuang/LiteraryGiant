import React, { useState } from 'react'
export const labels = { 'decision.options': '提交三项候选方向', 'decision.select': '选择精确方案', 'decision.withdraw': '撤回当前方向',
  'scene.create': '创建场景卡', 'scene.move': '调整场景归属与顺序', 'scene.update': '修改场景卡', 'scene.plan': '提交待审计划', 'scene.approve': '批准场景计划', 'scene.discard': '放弃待审计划', 'scene.drafted': '标记已起草', 'structure.create': '创建卷／章骨架', 'structure.update': '修改卷／章骨架' }
export const cardFields = { pov: '叙事视角', narrative_tense: '叙事时态', time_label: '故事时间', location: '地点', goal: '目标',
  conflict: '阻碍／冲突', required_information: '必须传达的信息', emotional_change: '情感变化', end_state: '结束状态' }
export const cardOf = item => Object.fromEntries([...Object.keys(cardFields), 'characters', 'word_min', 'word_max'].map(key => [key, item[key]]))
export function initial(section) {
  const slug = `${section}-${crypto.randomUUID()}`
  if (section === 'decisions') return { action: 'decision.options', slug, title: '', expected_version_id: 0, topic: { scope: 'work', document_id: null, key: '' },
    options: ['a', 'b', 'c'].map(id => ({ id, title: '', content: '' })), sources: [], request: '' }
  if (section === 'scenes') return { action: 'scene.create', slug, title: '', chapter_id: null, sequence: null, card: {} }
  return { action: 'structure.create', kind: 'part', slug, title: '', parent_id: null, sequence: null }
}
const NumberField = ({ label, value, change, min = 0 }) => <label>{label}<input type="number" min={min} value={value ?? ''} onChange={e => change(e.target.value === '' ? null : Number(e.target.value))}/></label>
export function PlanningForm({ change, documents, onPreview, onCancel, disabled }) {
  const [value, setValue] = useState(change), [characters, setCharacters] = useState((change.card?.characters ?? []).join('，')), action = value.action
  const update = patch => setValue({ ...value, ...patch })
  const input = (key, label, multiline = false) => <label>{label}{multiline ? <textarea value={value[key] ?? ''} onChange={e => update({ [key]: e.target.value })}/>
    : <input disabled={key === 'title' && action === 'decision.options' && value.expected_version_id !== 0} value={value[key] ?? ''} onChange={e => update({ [key]: e.target.value })}/>}</label>
  return <fieldset disabled={disabled}><legend>{labels[action]}</legend>
    {['decision.options', 'scene.create', 'structure.create', 'structure.update'].includes(action) && input('title', '标题')}
    {action === 'decision.options' && <>
      <label>方向范围<select value={value.topic.scope} disabled={value.expected_version_id !== 0} onChange={e => update({ topic: { ...value.topic, scope: e.target.value, document_id: null } })}>
        <option value="work">整部作品</option><option value="part">卷</option><option value="chapter">章</option></select></label>
      {value.topic.scope !== 'work' && <label>作用目标<select value={value.topic.document_id ?? ''} disabled={value.expected_version_id !== 0} onChange={e => {
        const doc = documents.find(doc => doc.id === Number(e.target.value)); update({ topic: { ...value.topic, document_id: doc?.id ?? null },
          sources: doc ? [...value.sources.filter(source => source.document_id !== doc.id), { document_id: doc.id, version_id: doc.active_version_id }] : value.sources })
      }}><option value="">选择目标</option>{documents.filter(doc => doc.kind === value.topic.scope).map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
      <label>主题键<input value={value.topic.key} disabled={value.expected_version_id !== 0} onChange={e => update({ topic: { ...value.topic, key: e.target.value } })}/></label>
      {input('request', '作者要求／讨论依据', true)}
      <label>来源文档（选择当前版本，可多选）<select multiple value={value.sources.map(source => String(source.document_id))} onChange={e => update({ sources: Array.from(e.target.selectedOptions, option => {
        const doc = documents.find(doc => doc.id === Number(option.value)); return { document_id: doc.id, version_id: doc.active_version_id }
      }) })}>{documents.map(doc => <option key={doc.id} value={doc.id}>{doc.title} · 第 {doc.version_number} 版</option>)}</select></label>
      <button type="button" onClick={() => update({ sources: value.sources.map(source => ({ ...source, version_id: documents.find(doc => doc.id === source.document_id)?.active_version_id ?? source.version_id })) })}>将已选来源更新为当前版本</button>
      {value.options.map((option, i) => <fieldset key={option.id}><legend>方案 {option.id}</legend>
        <label>方案标题<input value={option.title} onChange={e => update({ options: value.options.map((v,j) => i === j ? { ...v, title: e.target.value } : v) })}/></label>
        <label>行动、阻碍、代价与变化<textarea value={option.content} onChange={e => update({ options: value.options.map((v,j) => i === j ? { ...v, content: e.target.value } : v) })}/></label>
      </fieldset>)}<p>提交新方案会保留当前作者选择。</p>
    </>}
    {action === 'decision.select' && <><NumberField label="候选方案的版本号（可选历史版本）" min={1} value={value.options_version_number} change={number => update({ options_version_number: number })}/>
      {input('option_id', '方案标识')}<p>下一步预览会显示该精确版本的方案全文，确认后才改变方向。</p></>}
    {action === 'decision.withdraw' && <p>撤回当前选择，历史保留；不会自动选择更早的方案。</p>}
    {['scene.create', 'scene.update'].includes(action) && <>
      {action === 'scene.create' && <><label>所属章节<select value={value.chapter_id ?? ''} onChange={e => update({ chapter_id: e.target.value ? Number(e.target.value) : null })}>
        <option value="">暂不归章</option>{documents.filter(doc => doc.kind === 'chapter').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
        <NumberField label="场景顺序" value={value.sequence} change={sequence => update({ sequence })}/></>}
      {Object.entries(cardFields).map(([key,label]) => <label key={key}>{label}<textarea value={value.card[key] ?? ''} onChange={e => update({ card: { ...value.card, [key]: e.target.value } })}/></label>)}
      <label>出场人物（用逗号分隔）<input value={characters} onChange={e => { setCharacters(e.target.value); update({ card: { ...value.card, characters: e.target.value.split(/[,，]/u).map(v => v.trim()).filter(Boolean) } }) }}/></label>
      <div className="lgp-row">{[['word_min','最少字数'],['word_max','最多字数']].map(([key,label]) => <NumberField key={key} label={label} min={key === 'word_min' ? 0 : 1} value={value.card[key]} change={n => update({ card: { ...value.card, [key]: n } })}/>)}</div>
      <p>修改已批准的场景设计会使原计划需要重新批准；正文版本保持原样。</p>
    </>}
    {action === 'scene.move' && <><label>所属章节<select value={value.chapter_id ?? ''} onChange={e => update({ chapter_id: e.target.value ? Number(e.target.value) : null })}>
      <option value="">暂不归章</option>{documents.filter(doc => doc.kind === 'chapter').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
      <NumberField label="场景顺序" value={value.sequence} change={sequence => update({ sequence })}/><p>改变归属或顺序会要求重新批准场景计划。</p></>}
    {action === 'scene.plan' && <>{input('plan', '待审计划', true)}<p>当前已批准计划保留，作者批准后再替换。</p></>}
    {action === 'scene.approve' && <p>批准当前待审计划；若其依据的场景卡或正文已变化，系统会拒绝。</p>}
    {action === 'scene.discard' && <p>放弃本次待审替换计划；当前计划和历史保留。</p>}
    {['structure.create', 'structure.update'].includes(action) && <>
      <label>层级<select value={value.kind} disabled={action === 'structure.update'} onChange={e => update({ kind: e.target.value, parent_id: null })}><option value="part">卷</option><option value="chapter">章节</option></select></label>
      {value.kind === 'chapter' && <label>所属卷<select value={value.parent_id ?? ''} onChange={e => update({ parent_id: e.target.value ? Number(e.target.value) : null })}>
        <option value="">未分卷</option>{documents.filter(doc => doc.kind === 'part').map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>}
      <NumberField label="顺序" value={value.sequence} change={sequence => update({ sequence })}/><p>创建或调整骨架，不生成或采用正文。</p>
    </>}
    <div className="lgp-row"><button onClick={() => onPreview(value)}>预览变更</button><button onClick={onCancel}>取消编辑</button></div>
  </fieldset>
}
