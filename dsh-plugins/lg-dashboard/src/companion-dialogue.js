// Adjacent 1/2 entries form a conversation. Empty pairs are editable placeholders.
export function dialoguePairs(rows){
 const pairs=[]
 for(let i=0;i<rows.length;i+=2){
  const first=rows[i],reply=rows[i+1]
  if(first?.speaker==='1'&&reply?.speaker==='2'&&first.text?.trim()&&reply.text?.trim())pairs.push([first.text,reply.text])
 }
 return pairs
}

// Explicit scene boundaries support 1/2/3/1/2/3 without guessing where a scene ends.
export function dialogueScenes(scenes){
 return scenes.map(scene=>scene.filter(line=>['1','2','3','4','5','6'].includes(String(line.speaker))&&line.text?.trim()).map(line=>({speaker:String(line.speaker),text:line.text}))).filter(scene=>scene.length>=2)
}

// Plan speech lanes and their candidate avatar indices; visual avatars stay in two groups.
// These initial weights are refined from actual font measurements by the renderer.
export function planDialogue(lines,id=0,firstSide=0){
 const normalized=lines.map((line,i)=>typeof line==='string'?{speaker:String(i+1),text:line}:line)
 const speakers=[...new Set(normalized.map(line=>line.speaker))],count=Math.min(3,Math.max(2,speakers.length)),members=6/count
 const lanes=Array.from({length:count},()=>[])
 const turns=normalized.map((line,order)=>{
  const actor=speakers.indexOf(line.speaker),side=(firstSide+actor%count)%count,member=(id+side+Math.floor(actor/count))%members
  const turn={...line,order,side,member};lanes[side].push(turn);return turn
 })
 const scores=lanes.map(lane=>Math.sqrt(Math.max(10,...lane.map(line=>Array.from(line.text).reduce((n,c)=>n+(/[\u3000-\uffff]/.test(c)?1:.55),0)))))
 const sum=scores.reduce((a,b)=>a+b,0),floor=count===2?.34:.25
 return {count,members,lanes,turns,weights:scores.map(n=>floor+(1-floor*count)*n/sum)}
}

// Width only nudges selection (all scenes keep a positive chance).
export const dialogueLength=lines=>lines.reduce((n,line)=>n+Array.from((typeof line==='string'?line:line.text).replace(/\s/g,'')).length,0)
export function dialogueWeight(lines,width){
 const clamp=n=>Math.max(-1,Math.min(1,n))
 return 1+.3*clamp((width-440)/240)*clamp((dialogueLength(lines)-80)/80)
}
export const dialogueDwell=lines=>Math.max(4000,dialogueLength(lines)*250)

// Speakers alternate groups; each scene assigns distinct members to its speakers.
export function createDialogue({pairs,onChange,random=Math.random,setTimer=setTimeout,clearTimer=clearTimeout,exitMs=()=>400,width=()=>440}){
 let timer,enabled=false,disposed=false,previous=-1,id=0,current=null
 const between=(min,max)=>min+random()*(max-min)
 const later=(fn,ms)=>{clearTimer(timer);timer=setTimer(()=>{if(enabled&&!disposed)fn()},ms)}
 const publish=phase=>{current={...current,phase};onChange(current)}
 const show=turn=>{
  const line=current.plan.turns[turn],{side,member}=line
  const visible=[...current.visible];visible[side]={text:line.text,member,order:turn}
  current={...current,turn,visible,phase:turn===0?'first':'both'};onChange(current)
  if(turn+1<current.lines.length)later(()=>show(turn+1),turn===0?between(800,2200):between(4000,6500))
  else later(()=>{publish('leaving');later(()=>{publish('rest');later(begin,between(650,1400))},exitMs())},exitMs()+dialogueDwell(current.lines)*between(.9,1.1))
 }
 const begin=()=>{
  const choices=pairs.map((_,i)=>i).filter(i=>pairs.length===1||i!==previous)
  const weights=choices.map(i=>dialogueWeight(pairs[i],width()))
  let pick=random()*weights.reduce((a,b)=>a+b,0)
  previous=choices.at(-1)
  for(let i=0;i<choices.length;i++){pick-=weights[i];if(pick<0){previous=choices[i];break}}
  const lines=pairs[previous],count=planDialogue(lines).count,firstSide=Math.floor(random()*count)
  current={id:++id,lines,firstSide,plan:planDialogue(lines,id,firstSide),visible:Array(count).fill(null)}
  show(0)
 }
 return {
  setEnabled(value){
   const next=!!value&&pairs.length>0
   if(disposed||next===enabled)return
   enabled=next;clearTimer(timer)
   if(enabled)later(begin,between(300,1700))
   else {current=null;onChange(null)}
  },
  dispose(){disposed=true;clearTimer(timer)},
 }
}
