// One pending update per view. Pointer drags wait for release; native window
// resizing has no DOM pointer gesture and settles after 150 ms of quiet.
export function createResizeSettler(target,onSettle){
 let timer,pending=false,pressed=false,value
 const arm=()=>{
  clearTimeout(timer)
  if(pending&&!pressed)timer=setTimeout(()=>{pending=false;onSettle(value)},150)
 }
 const down=()=>{pressed=true;clearTimeout(timer)}
 const up=()=>{pressed=false;arm()}
 target.addEventListener('pointerdown',down,true)
 for(const name of ['pointerup','pointercancel'])target.addEventListener(name,up,true)
 target.addEventListener('blur',up)
 return {
  schedule(next){value=next;pending=true;arm()},
  dispose(){
   clearTimeout(timer)
   target.removeEventListener('pointerdown',down,true)
   for(const name of ['pointerup','pointercancel'])target.removeEventListener(name,up,true)
   target.removeEventListener('blur',up)
  },
 }
}
