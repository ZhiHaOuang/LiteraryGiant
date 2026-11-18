import React from 'react'

function Quotes({evidence}) {
  return evidence.map((q,i)=><blockquote key={i}>文档 {q.document_id} · 版本 {q.version_id} · {q.quote}</blockquote>)
}

export function AnalysisReport({report}) {
  return <section aria-label="已保存候选报告"><h4>已保存候选报告</h4><p>{report.summary}</p>
    {report.entries.map(e=><article key={e.key}><strong>{e.label}</strong><p>{e.analysis}</p><Quotes evidence={e.evidence}/></article>)}
    <p>审阅发现 {report.findings.length} 项。</p>
    {report.findings.map((f,i)=><article key={i}><strong>{({canon_conflict:'正式设定冲突',style:'文风',question:'待核对'})[f.kind]}</strong>
      <p>{f.explanation}</p>{f.kind==='canon_conflict'&&<blockquote>设定 #{f.fact_id} · {f.fact_quote}</blockquote>}
      <Quotes evidence={f.evidence}/></article>)}
  </section>
}
