export function compareSource(a,b){
 const left=a.display?.source,right=b.display?.source
 const chapter=(left?.chapter??Infinity)-(right?.chapter??Infinity)
 if(chapter)return chapter
 const l=left?.document_order??[],r=right?.document_order??[]
 for(let i=0;i<Math.max(l.length,r.length);i++){
  const delta=(l[i]??-1)-(r[i]??-1)
  if(delta)return delta
 }
 return (left?.paragraph??Infinity)-(right?.paragraph??Infinity)||0
}

// Card summaries are selected from records already filtered to the reading scope.
export function characterPortraits(records,people=records){
 const selected=new Map()
 const portraits=records.filter(r=>r.type==='portrait'&&['candidate','confirmed'].includes(r.approval)&&r.freshness==='current'&&!r.related_changed.length)
 portraits.sort((a,b)=>Number(b.approval==='confirmed')-Number(a.approval==='confirmed')
  ||Number(b.payload.aspect==='behavior')-Number(a.payload.aspect==='behavior')
  ||compareSource(a,b)||a.id.localeCompare(b.id,'zh-CN',{numeric:true}))
 for(const r of portraits){
  if(!selected.has(r.payload.subject))selected.set(r.payload.subject,{
   facet:r.display?.facet,description:r.payload.description,approval:r.approval,chapter:r.display?.source?.chapter??null,
   traits:[],
  })
 }
 const aliases=new Map(people.filter(r=>r.payload?.entity_kind==='character').map(r=>
  [r.id,[r.payload.name,...r.payload.aliases??[]].filter(Boolean).sort((a,b)=>b.length-a.length)]))
 // Value judgments and explicit behavior headings can label a card. Leave ambiguous prose to the dossier.
 for(const r of portraits.sort((a,b)=>Number(b.approval==='confirmed')-Number(a.approval==='confirmed')
  ||Number(b.payload.aspect==='value')-Number(a.payload.aspect==='value')||compareSource(a,b))){
  const summary=selected.get(r.payload.subject)
  if(summary.traits.length===2||!['value','behavior','contradiction'].includes(r.payload.aspect))continue
  const name=aliases.get(r.payload.subject)?.find(alias=>r.title?.startsWith(alias))
  if(!name)continue
  const heading=r.title.slice(name.length).match(/^(?:的|[：:]|对[^的，。]{1,10}的)(.+)$/u)?.[1]
  if(!heading||/是否|并非|不是|缺乏|缺少|可能|似乎|假象|[？?]/u.test(heading))continue
  for(const term of heading.split(/[与、]/u)){
   if(!/^[\p{Script=Han}]{2,5}$/u.test(term)||/的|^(?:态度|倾向|表现|行为|高度重视|看法)$/u.test(term))continue
   const label=({实用态度:'务实',平静直视:'沉着',紧张掩饰:'掩饰紧张'})[term]??term
   if(!summary.traits.some(t=>t.label===label))summary.traits.push({label,record_id:r.id,approval:r.approval})
   if(summary.traits.length===2)break
  }
 }
 return selected
}
