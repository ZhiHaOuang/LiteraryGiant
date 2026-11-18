// Only 2–3 bubbles: try widths in 4px steps, preferring fewer, fuller lines.
// Each lane must contain a candidate avatar center for its pointer.
export function fitBubbleWidths(texts,width,anchors,gap=10,measureLines){
 const n=texts.length,available=Math.max(n,width-gap*(n-1)),budget=Math.floor(available/4)
 const cache=texts.map(()=>new Map())
 const minimum=Math.max(1,Math.min(16,Math.floor(budget/n))),states=[new Map([[0,{cost:0,widths:[]}]])]
 for(let i=0;i<n;i++){
  const next=new Map()
  for(const [used,state] of states[i])for(let cells=minimum;cells<=budget-used-minimum*(n-i-1);cells++){
   const w=cells*4,start=used*4+i*gap,end=start+w
   if(anchors[i]?.length&&!anchors[i].some(x=>x>=start+4&&x<=end-4))continue
   const ink=Math.max(1,w-14)
   if(!cache[i].has(w))cache[i].set(w,measureLines?measureLines(i,w):Math.max(1,Math.ceil(texts[i]/ink)))
   const lines=cache[i].get(w),waste=(lines*ink-texts[i])/(lines*ink)
   // When line counts tie, wrap the longer sentence rather than a short one.
   const cost=state.cost+100*lines*lines+10000*(lines-1)/Math.max(1,texts[i])+10*waste*waste,total=used+cells
   if(!next.has(total)||cost<next.get(total).cost)next.set(total,{cost,widths:[...state.widths,w]})
  }
  states.push(next)
 }
 const result=states[n].get(budget)?.widths??Array(n).fill(available/n)
 result[n-1]+=available-result.reduce((a,b)=>a+b,0)
 return result
}
