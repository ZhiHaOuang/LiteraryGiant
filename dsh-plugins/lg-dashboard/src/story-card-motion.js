// A small shared spring clock for the cards in one row. No React renders per frame.
export function createCardSpring({read,write,requestFrame,cancelFrame,reduced}){
 const states=new Map();let frame=0,last=0,active='',destroyed=false
 const targets=()=>{
  const ids=read(),at=ids.indexOf(active)
  for(const id of ids)if(!states.has(id))states.set(id,{value:0,velocity:0})
  return ids.map((id,i)=>({id,state:states.get(id),target:at<0?0:.22*Math.exp(-Math.pow((i-at)/.85,2))}))
 }
 function stop(){if(frame)cancelFrame(frame);frame=0;last=0}
 function settle(){stop();for(const {id,state,target} of targets()){state.value=target;state.velocity=0;write(id,1+target)}}
 function step(now){
  frame=0;if(destroyed)return
  if(reduced()){settle();return}
  const dt=last?Math.min(2.5,Math.max(0,(now-last)/16.667)):1;last=now
  let moving=false
  for(const {id,state,target} of targets()){
   state.velocity=(state.velocity+(target-state.value)*.11*dt)*Math.pow(.69,dt)
   state.value+=state.velocity*dt
   if(Math.abs(target-state.value)<.0001&&Math.abs(state.velocity)<.0001){state.value=target;state.velocity=0}else moving=true
   write(id,Math.max(.05,1+state.value))
  }
  if(moving)frame=requestFrame(step);else last=0
 }
 return {
  set(id=''){if(destroyed)return;active=id;if(reduced())settle();else if(!frame)frame=requestFrame(step)},
  reset(){if(destroyed)return;active='';settle()},
  destroy(){destroyed=true;stop();states.clear()},
 }
}
