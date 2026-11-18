import test from 'node:test'
import assert from 'node:assert/strict'
import {createDialogue,dialoguePairs,planDialogue,dialogueWeight,dialogueDwell,dialogueLength} from '../lg-dashboard/src/companion-dialogue.js'
function clock(){
 let now=0,id=0;const timers=new Map()
 return {setTimer(fn,ms){timers.set(++id,{fn,time:now+ms});return id},clearTimer(id){timers.delete(id)},next(){const [id,t]=[...timers].sort((a,b)=>a[1].time-b[1].time)[0]??[];if(!t)return null;const delay=t.time-now;now=t.time;timers.delete(id);t.fn();return delay},get size(){return timers.size}}
}
test('each round preserves question/reply ordering when either two-character group starts; reply coexists before shared exit',()=>{
 for(const random of [()=>0,()=>.99]){
  const c=clock(),changes=[],controller=createDialogue({...c,pairs:[['hello','reply'],['other','answer']],random,onChange:r=>changes.push(r),exitMs:()=>500})
  controller.setEnabled(true);assert.ok(c.next()>=300)
  assert.equal(changes.at(-1).phase,'first');assert.equal(changes.at(-1).firstSide,random()<.5?0:1)
  const initial=changes.at(-1),replyDelay=c.next();assert.ok(replyDelay>=800&&replyDelay<=2200)
  assert.equal(changes.at(-1).phase,'both');assert.equal(changes.at(-1).id,initial.id)
  const dwell=c.next();assert.ok(Math.abs(dwell-(500+dialogueDwell(initial.lines)*(.9+.2*random())))<.001);assert.equal(changes.at(-1).phase,'leaving')
  assert.equal(c.next(),500);assert.equal(changes.at(-1).phase,'rest')
  const rest=c.next();assert.ok(rest>=650&&rest<=1400);assert.notDeepEqual(changes.at(-1).lines,initial.lines)
  controller.dispose();assert.equal(c.size,0)
 }
})
test('pausing the shared conversation cancels the pending reply for both groups',()=>{
 const c=clock(),changes=[]
 const controller=createDialogue({...c,pairs:[['first','reply']],onChange:r=>changes.push(r)})
 controller.setEnabled(true);c.next();assert.equal(changes.at(-1).phase,'first')
 controller.setEnabled(false);assert.equal(changes.at(-1),null);assert.equal(c.size,0)
 controller.setEnabled(true);c.next();assert.equal(changes.at(-1).phase,'first')
 c.next();assert.equal(changes.at(-1).phase,'both')
 assert.deepEqual(changes.at(-1).lines,['first','reply'])
 controller.dispose();assert.equal(c.size,0)
})
test('blank/incomplete pairs never play; empty playlist schedules no timers',()=>{
 assert.deepEqual(dialoguePairs([{speaker:'1',text:''},{speaker:'2',text:''},{speaker:'1',text:'unfinished'}]),[])
 const c=clock(),controller=createDialogue({...c,pairs:[],onChange:()=>assert.fail('must not play')})
 controller.setEnabled(true);assert.equal(c.size,0);controller.dispose()
})
test('three speakers keep their member across 123123 turns and leave only after the last reply',()=>{
 const c=clock(),changes=[],lines=['1','2','3','1','2','3'].map(speaker=>({speaker,text:'line '+speaker}))
 const controller=createDialogue({...c,pairs:[lines],random:()=>0,onChange:r=>changes.push(r)})
 controller.setEnabled(true);const assignments={}
 for(let i=0;i<6;i++){
  c.next();const round=changes.at(-1),line=round.visible.find(v=>v?.order===i),side=round.visible.indexOf(line),actor=lines[i].speaker
  assert.equal(round.turn,i);assert.equal(line.text,'line '+actor)
  if(assignments[actor])assert.deepEqual([side,line.member],assignments[actor]);else assignments[actor]=[side,line.member]
 }
 assert.notDeepEqual(assignments['1'],assignments['3']);assert.equal(changes.at(-1).phase,'both')
 c.next();assert.equal(changes.at(-1).phase,'leaving');controller.dispose();assert.equal(c.size,0)
})

test('scene plan gives the long line more width, reserves avatar space and splits three actors into three pairs',()=>{
 const two=planDialogue(['短句','这是一句更长的对白，需要多分配一点宽度，让它在同一排看起来平衡。'],1,0)
 assert.equal(two.count,2);assert.equal(two.members,3);assert.ok(two.weights[1]>two.weights[0]);assert.ok(two.weights.every(w=>w>=.34&&w<=.66))
 const three=planDialogue(['1','2','3','1','2','3'].map(speaker=>({speaker,text:'对白'+speaker})),3,1)
 assert.equal(three.count,3);assert.equal(three.members,2);assert.equal(three.lanes.length,3)
 assert.ok(Math.abs(three.weights.reduce((a,b)=>a+b,0)-1)<1e-10)
 for(let i=0;i<3;i++){assert.equal(three.turns[i].side,three.turns[i+3].side);assert.equal(three.turns[i].member,three.turns[i+3].member)}
 assert.equal(new Set(three.turns.map(t=>t.side)).size,3)
})

test('width gently favors longer scenes on wide cards and shorter ones on narrow cards without excluding any',()=>{
 const short=['短'.repeat(10),'句'.repeat(10)],long=['长'.repeat(80),'句'.repeat(80)]
 assert.ok(dialogueWeight(long,680)>dialogueWeight(short,680))
 assert.ok(dialogueWeight(long,200)<dialogueWeight(short,200))
 assert.equal(dialogueWeight(long,440),dialogueWeight(short,440))
 for(const width of [0,200,440,680,2000])for(const lines of [short,long])assert.ok(dialogueWeight(lines,width)>=.7&&dialogueWeight(lines,width)<=1.3)
 for(const [width,expected] of [[200,short],[680,long]]){
  const c=clock(),changes=[],controller=createDialogue({...c,pairs:[short,long],width:()=>width,random:()=>.5,onChange:r=>changes.push(r)})
  controller.setEnabled(true);c.next();assert.deepEqual(changes.at(-1).lines,expected);controller.dispose()
 }
})
test('shared dwell scales with scene characters and starts after the last entrance',()=>{
 assert.equal(dialogueLength(['😡 a','中 文']),4)
 assert.equal(dialogueDwell(['很短','对白']),4000)
 assert.equal(dialogueDwell(['字'.repeat(160)]),2*dialogueDwell(['字'.repeat(80)]))
 const lines=[{speaker:'1',text:'字'.repeat(30)},{speaker:'2',text:'字'.repeat(30)},{speaker:'3',text:'字'.repeat(40)}]
 const c=clock(),changes=[],controller=createDialogue({...c,pairs:[lines],random:()=>.5,exitMs:()=>400,onChange:r=>changes.push(r)})
 controller.setEnabled(true);c.next();c.next();assert.equal(changes.at(-1).turn,1);c.next();assert.equal(changes.at(-1).turn,2)
 assert.equal(c.next(),25400);assert.equal(changes.at(-1).phase,'leaving');controller.dispose()
})
