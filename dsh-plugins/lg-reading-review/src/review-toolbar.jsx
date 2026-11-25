import React, { useId, useLayoutEffect, useRef } from 'react'

const settings = [
  ['font', 'Font', [['serif','Serif'],['sans','Sans serif'],['kai','Kai']]],
  ['size', 'Font size', [14,16,18,20,22,24,28,32].map(n => [n, String(n)]), 'px'],
  ['line', 'Line height', [1.4,1.6,1.9,2.2,2.5].map(n => [n,n+'×'])],
  ['gap', 'Paragraph spacing', [[0,'None'],[0.4,'Compact'],[0.75,'Normal'],[1.2,'Relaxed'],[1.6,'Wide']]],
]
const versionStates = { candidate:'Candidate', rejected:'Rejected', draft:'Draft', accepted:'Accepted' }

function ChoiceGroup({label, unit, choices, value, onChange, disabled = false, scrollable = false}) {
  const id = useId()
  const options = useRef(null)
  useLayoutEffect(() => {
    const list = options.current
    if (!scrollable) return
    function revealChoice() {
      const choice = list.querySelector('[aria-pressed="true"]')
      if (!choice || list.scrollHeight <= list.clientHeight) return
      const top = choice.offsetTop
      if (top < list.scrollTop) list.scrollTop = top
      else if (top + choice.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = top + choice.offsetHeight - list.clientHeight
      }
    }
    revealChoice()
    const observer = new ResizeObserver(revealChoice)
    observer.observe(list)
    return () => observer.disconnect()
  }, [scrollable, value, choices.length])
  return <div className="lgrv-setting" role="group" aria-labelledby={id}>
    <div className="lgrv-setting-label"><span id={id}>{label}</span>{unit && <small>{unit}</small>}</div>
    <div className="lgrv-options" ref={options}>
      {choices.map(([key, text, unavailable]) => {
        const name = unit ? text + ' ' + unit : text
        return <button type="button" key={key} title={name} aria-label={name} aria-pressed={key === value}
          disabled={disabled || unavailable} onClick={() => onChange(key)}>{text}</button>
      })}
    </div>
  </div>
}

export function ReviewSettings({type,onChange,books,book,onBook,data,onVersion,disabled}) {
  return <section className="lgrv-settings" aria-label="Reading settings">
    {books.length > 0 && <div className="lgrv-sources">
      <ChoiceGroup label="Book" value={book?.path} disabled={disabled} onChange={onBook} scrollable
        choices={books.map(b=>[b.path,b.name || b.path,!!b.error])}/>
      {data && <ChoiceGroup label="Version" value={data.selected.id} disabled={disabled} onChange={onVersion} scrollable
        choices={data.versions.map(v=>[v.id,'v'+v.version_number+' · '+(v.id === data.document.activeVersion
          ? 'Current manuscript' : versionStates[v.state] ?? v.state)])}/>}
    </div>}
    <div className="lgrv-typography">
      {settings.map(([key,label,choices,unit]) => <ChoiceGroup key={key} label={label} unit={unit}
        choices={choices} value={type[key]} onChange={value=>{if(value!==type[key]) onChange({...type,[key]:value})}}/>)}
    </div>
  </section>
}
