// Bencho's independent boxes and 2px air, applied to actual paired Agent totals.
export const INPUT_HEIGHT=112, OUTPUT_HEIGHT=80, SEGMENT_GAP=2, BASE_LIFT=3
export const MAX_BAR_WIDTH=148/21, COLUMN_GAP=6
export const agentLabels={coordinator:'Lead',analysis:'Analysis',planning:'Planning',writing:'Writing'}
export const segmentLabel=p=>({text:'Answers',reasoning:'Reasoning',toolarg:'Tool args',unknown:'Unrecorded',other:'Other'}[p.key]??p.label)
export function agentStacks(pairs,width,paired=true){
 const cell=width/Math.max(1,pairs.length),barWidth=Math.max(1,Math.min(MAX_BAR_WIDTH,cell-COLUMN_GAP))
 const sides=paired?['input','output']:['input']
 const maxima=Object.fromEntries(['input','output'].map(side=>[side,Math.max(0,...pairs.map(p=>p[side].value??0))]))
 const maxParts=Object.fromEntries(['input','output'].map(side=>[side,Math.max(1,...pairs.map(p=>p[side].parts.filter(s=>s.value>0).length))]))
 const columns=pairs.flatMap((pair,index)=>sides.map(side=>{
  const data=pair[side],height=side==='input'?INPUT_HEIGHT:OUTPUT_HEIGHT
  // Reserve the same gap budget for every Agent on this side, preserving one scale.
  const scale=(height-BASE_LIFT-4-SEGMENT_GAP*(maxParts[side]-1))/Math.max(1,maxima[side])
  let offset=0
  const parts=(data.value===null?[]:data.parts.filter(p=>p.value>0)).map(part=>{
   const h=part.value*scale,result={...part,label:segmentLabel(part),offset,height:h}
   offset+=h+SEGMENT_GAP;return result
  })
  return {id:pair.role+':'+side,role:pair.role,side,value:data.value,missing:pair.missing,
   parts,height:parts.length?offset-SEGMENT_GAP:0,left:index*cell+(cell-barWidth)/2,width:barWidth}
 }))
 return {columns,maxima,cell,barWidth}
}
