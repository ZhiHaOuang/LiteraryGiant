import React from 'react'

export function rulesInput(fields) {
  const rules = {}
  for (const name of ['required','forbidden']) {
    const terms = (fields[name] ?? '').split('\n').filter(term => term.trim())
    if (terms.length) rules[name] = terms
  }
  if (fields.min) rules.minHan = Number(fields.min)
  if (fields.max) rules.maxHan = Number(fields.max)
  if (fields.ending) rules.ending = fields.ending
  return rules
}
export function RuleFields({fields,onChange}) {
  const update = (key,value) => onChange({...fields,[key]:value})
  return <>
      <label>最少汉字数<input type="number" min="0" max="400000" step="1" value={fields.min??''} onChange={e=>update('min',e.target.value)}/></label>
      <label>最多汉字数<input type="number" min="0" max="400000" step="1" value={fields.max??''} onChange={e=>update('max',e.target.value)}/></label>
      <label>必含词（每行一个）<textarea value={fields.required??''} maxLength={3232} onChange={e=>update('required',e.target.value)}/></label>
      <label>禁用词（每行一个）<textarea value={fields.forbidden??''} maxLength={3232} onChange={e=>update('forbidden',e.target.value)}/></label>
      <label>精确结尾（可留空）<textarea value={fields.ending??''} maxLength={500} onChange={e=>update('ending',e.target.value)}/></label>
  </>
}
export function CheckResult({result,selection,onSelect,disabled}) {
  return <section aria-label="正文检查结果"><p>文档 {result.target.document} · 版本 ID {result.target.version} · {result.metrics.han} 汉字 · {result.metrics.characters} 字符 · {result.metrics.paragraphs} 非空行</p>
      <p role="status">{result.passed===null?'未设置规则，仅显示统计。':result.passed?'已设置的规则全部通过。':'存在未通过的规则。'}</p>
      <ul>{result.checks.map((check,index)=><li key={index}><label>{onSelect&&!check.passed&&<input type="checkbox" disabled={disabled} checked={selection.includes(index)} onChange={e=>onSelect(e.target.checked?[...selection,index]:selection.filter(i=>i!==index))}/>}
        {check.passed?'通过':'未通过'} · {check.kind==='han-range'?`汉字数 ${check.actual}，要求 ${check.min}–${check.max}`:check.kind==='ending'?`精确结尾 ${JSON.stringify(check.term)}；实际 ${JSON.stringify(check.actual)}`:`${check.kind==='required'?'必含':'禁用'} ${JSON.stringify(check.term)} · 命中 ${check.count} 次`}</label>
        {!!check.positions?.length&&<small> · 字符位置（从 0 起，UTF-16）：{check.positions.map(p=>`${p.start}–${p.end}`).join('、')}{check.truncated?'；仅列前 20 处':''}</small>}
      </li>)}</ul>
    </section>
}
