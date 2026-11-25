// The grid keeps its previous width until the size observer delivers the new one.
// Read both sets of card bounds in batches, only when a card can change rows.
export function createPeopleReflow(grid){
 const active=new Set()
 let previousColumns=0
 function stop(){
  for(const animation of active)animation.cancel()
  active.clear()
 }
 function resize(width,columns){
  if(width<=0)return
  const crossing=previousColumns!==0&&previousColumns!==columns
  const cards=crossing?Array.from(grid.children):[]
  const before=cards.map(card=>card.getBoundingClientRect())
  if(crossing)stop()
  grid.style.width=width+'px'
  grid.style.setProperty('--people-columns',String(columns))
  previousColumns=columns
  const after=cards.map(card=>card.getBoundingClientRect())
  cards.forEach((card,index)=>{
   const from=before[index],to=after[index]
   if(!from.width||!to.width||!from.height||!to.height)return
   const dx=from.left-to.left,dy=from.top-to.top
   if(Math.max(Math.abs(dx),Math.abs(dy),Math.abs(from.width-to.width),Math.abs(from.height-to.height))<.5)return
   const animation=card.animate([
    {translate:dx+'px '+dy+'px',scale:(from.width/to.width)+' '+(from.height/to.height),transformOrigin:'0 0'},
    {translate:'0px 0px',scale:'1 1',transformOrigin:'0 0'},
   ],{duration:240,easing:'cubic-bezier(.25,.72,.22,1)'})
   active.add(animation)
   animation.onfinish=()=>active.delete(animation)
  })
 }
 function destroy(){
  stop()
  grid.style.removeProperty('--people-columns')
  grid.style.removeProperty('width')
 }
 return {resize,destroy}
}
