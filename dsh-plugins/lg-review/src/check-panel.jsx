import React, { useEffect, useRef, useState } from 'react'

import { RuleFields, rulesInput, CheckResult } from './rule-fields.jsx'

export function CheckPanel({path,data,disabled}) {
  const [fields,setFields]=useState({})
  const [result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const active=useRef(null)
  useEffect(()=>()=>active.current?.abort(),[])
  const change=value=>{setFields(value);setResult(null);setError('')}
  async function run() {
    const controller=new AbortController();active.current=controller;setBusy(true);setResult(null);setError('')
    const rules=rulesInput(fields)
    try {
      const response=await fetch('api/lg/review',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify({action:'check',path,target:{document:data.document.id,version:data.selected.id,token:data.token},rules})})
      const payload=await response.json();if(!payload.ok)throw new Error(payload.error)
      if(!controller.signal.aborted)setResult(payload.value)
    } catch(error) {if(!controller.signal.aborted)setError(error.message)}
    finally {if(!controller.signal.aborted)setBusy(false)}
  }
  return <details><summary>免费正文规则检查</summary>
    <p>检查当前查看版本的全文，不含子场景。汉字数不计标点、数字和拉丁字母；词表区分大小写、逐字匹配。精确结尾包含末尾空白。结果不代表文学质量或作者采用。</p>
    <fieldset disabled={disabled||busy}>
      <RuleFields fields={fields} onChange={change}/>
      <button onClick={run}>{busy?'正在检查…':'检查所选版本（不调用模型）'}</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
    {result&&<CheckResult result={result}/>}
  </details>
}
