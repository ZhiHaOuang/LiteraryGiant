// Cached advances estimate wrapping; the final browser pass owns exact line breaks.
export function measureBubbleText(text,measure){
 const tokens=[]
 for(const part of text.match(/[A-Za-z0-9]+(?:[.'’-][A-Za-z0-9]+)*|[^\r\n]|\n/gu)??[]){
  if(tokens.length&&(/^[，。！？、；：）》」』】〕〉,.!?;:%”’]/u.test(part)||/[（《「『【〔〈“‘]$/u.test(tokens.at(-1))))tokens[tokens.length-1]+=part
  else tokens.push(part)
 }
 const advances=tokens.map(token=>({token,width:measure(token),chars:Array.from(token,measure)}))
 return {width:measure(text),linesAt(width){
  const ink=Math.max(1,width-14);let lines=1,used=0
  for(const item of advances){
   if(item.token==='\n'){lines++;used=0;continue}
   if(/^\s+$/u.test(item.token)){if(used)used=Math.min(ink,used+item.width);continue}
   for(const advance of item.width<=ink?[item.width]:item.chars){
    if(used&&used+advance>ink){lines++;used=0}
    used+=advance
   }
  }
  return lines
 }}
}

// Only 2–3 lanes. Bound the search to 192 cells, with pixel precision in narrow cards.
// Line estimates use cached text metrics, never DOM reads or writes.
export function fitBubbleWidths(texts,width,anchors,gap=6,measureLines){
 const n=texts.length
 if(!n)return []
 const available=Math.max(n,width-gap*(n-1)),budget=Math.max(n,Math.min(192,Math.floor(available))),unit=available/budget
 const cache=texts.map(()=>new Map())
 // A short reply only reserves its natural width, leaving room for long sentences.
 const minimum=texts.map(text=>Math.max(1,Math.min(Math.ceil(Math.min(64,text+14)/unit),Math.floor(budget/n))))
 const states=[new Map([[0,{cost:0,widths:[]}]])]
 for(let i=0;i<n;i++){
  const next=new Map()
  const reserved=minimum.slice(i+1).reduce((sum,cells)=>sum+cells,0)
  for(const [used,state] of states[i])for(let cells=i===n-1?budget-used:minimum[i];cells<=budget-used-reserved;cells++){
   const w=cells*unit,start=used*unit+i*gap,end=start+w
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
