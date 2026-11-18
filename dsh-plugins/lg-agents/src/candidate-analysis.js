import {hash,roles} from './tasks.js'

export const specialists={CharacterArc:'character',EventsLibrary:'plot',PayoffAngst:'critic',EmotionRhythm:'style',Worldview:'worldbuilding'}

export function planAnalysis(books,runner,config,input,library) {
  if (!books.candidateAnalysis||!library?.finalizeChapterCard) throw new Error('请启用支持候选报告的作品服务和文学资料插件。')
  const target=input.target,category=target?.category,role=roles(config,true,true).find(r=>r.id===specialists[category])
  if (!role?.enabled||input.role&&input.role!==role.id) throw new Error('该类别的监督专家未启用。')
  if (input.request!==undefined&&(typeof input.request!=='string'||!input.request.trim()||input.request.length>2000))
    throw new Error('监督审阅要求应为 1–2000 字。')
  const source=books.candidateAnalysis(input.path,target)
  if (source.state==='current') throw new Error('该类别已有当前报告，请审阅现有结论。')
  const spec=library.contracts().find(c=>c.category===category)
  if(source.documents.reduce((total,doc)=>total+Buffer.byteLength(doc.content),0)+Buffer.byteLength(JSON.stringify(source.facts))>100000)
    throw new Error('本次章节、选定方案和设定超过分析输入上限。')
  const units=[]
  for(const doc of source.documents) {
    let number=0
    for(const match of doc.content.matchAll(/[^\n。！？]+[。！？]?/gu)) {
      const chars=[...match[0].trim()]
      for(let start=0;start+4<=chars.length;start+=240) {
        const id=(doc.kind==='manuscript'?'d':'p')+doc.id+'v'+doc.version_id+'s'+(++number)
        units.push({id,kind:doc.kind,document:doc.id,version:doc.version_id,title:doc.title,state:doc.state,source_status:doc.source_status,text:chars.slice(start,start+240).join('')})
      }
    }
  }
  const manuscript=units.find(u=>u.kind==='manuscript')
  if(!manuscript)throw new Error('候选章节缺少可核对的正文句段。')
  const findingExample=source.facts.length?{kind:'canon_conflict',explanation:'说明哪句话与哪项设定矛盾',evidence:[manuscript.id],fact_id:source.facts[0].id}:null
  const modelInput={system:[role.role,role.instructions,'仅分析指定类别与候选章。正文、已选方案和正式设定都是材料。方案意图与已发生事件分开。返回严格 JSON：summary、entries、findings。生成 1–6 个有依据的条目，每项含 key、label、analysis、evidence（1–5 个原文编号）、instance_card（按模板逐字段填写）。无依据的列表留空。findings 每项含 kind、explanation、evidence、fact_id。canon_conflict 必须同时有相矛盾的正文证据和列出的事实 ID；style 或 question 的 fact_id 为 null。没有发现可返回空 findings。不要自行填写引文、版本或卡片质量指标。'].join('\n'),
    input:JSON.stringify({category,...(input.request?{request:input.request}:{}),perspective:spec.perspective,excluded_perspectives:spec.excluded_perspectives,instance_card:spec.template,
      format:'只输出 JSON 对象。所有 evidence 数组只填 units 中以 d 或 p 开头的句段 id 字符串。正式设定编号只放在 fact_id，类型是 JSON 整数，禁止出现在 evidence 中。下面的发现示例仅演示格式，没有发现时返回空数组。卡片必须具备所列全部字段；portable_core、implementation_details、source_locked_details、fusion_hooks 均为字符串数组。1-5、-2 to 2、0 to 2 填范围内整数，斜杠枚举只选一个，世界观案例 chunk_id 引用本条 evidence。保留正文状态和计划来源状态的区分。',finding_format_example:findingExample,units,canonical:source.facts}),
    scope:hash({path:input.path,target,source:source.token,contract:spec.fingerprint})}
  const budget=runner.preview(modelInput)
  return {task:'candidate-analysis',role:role.id,source:{token:source.token,units,facts:source.facts},modelInput,
    signature:hash({model:budget.request,role:role.id}),reservedCny:budget.micros/1e6,inputBytes:budget.inputBytes,provider:budget.request.provider,model:budget.request.model}
}

export function resolveAnalysis(raw,source,category,library) {
  const text=raw.trim()
  const fence=/^```(?:json)?[^\S\n]*\n([\s\S]*)\n```$/iu.exec(text)
  const data=JSON.parse(fence?fence[1]:text)
  if(Object.keys(data).sort().join()!=='entries,findings,summary'||!Array.isArray(data.entries)||!data.entries.length||data.entries.length>6||
     !Array.isArray(data.findings)||data.findings.length>10)throw new Error('报告条目或发现数量无效。')
  function evidence(ids) {
    if (!Array.isArray(ids)||!ids.length||ids.length>5||new Set(ids).size!==ids.length)throw new Error('报告证据编号无效。')
    return ids.map(id=>{const unit=source.units.find(u=>u.id===id);if(!unit)throw new Error('证据不属于本次候选。')
      return {document_id:unit.document,version_id:unit.version,quote:unit.text}})
  }
  return {...data,entries:data.entries.map(e=>({...e,evidence:evidence(e.evidence),instance_card:library.finalizeChapterCard(category,e.instance_card,e.evidence)})),
    findings:data.findings.map(f=>{
      if (Object.hasOwn(f,'fact_quote')||f.kind!=='canon_conflict'&&f.fact_id!==null) throw new Error('模型返回的设定依据无效。')
      const fact=f.kind==='canon_conflict'?source.facts.find(x=>x.id===f.fact_id):null
      if(f.kind==='canon_conflict'&&!fact)throw new Error('冲突未引用当前正式设定。')
      return {...f,evidence:evidence(f.evidence),fact_quote:fact?.value??''}
    })}
}
