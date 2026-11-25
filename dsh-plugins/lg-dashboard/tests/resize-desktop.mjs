import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {existsSync,mkdirSync} from 'node:fs'
import {checkPeopleReflow} from './people-reflow-desktop.mjs'
const {_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const root=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(root&&existsSync(root+'/.dashboard-test-profile'),'Use a marked isolated test profile')
const out=process.env.LG_PREVIEW_DIR??root+'/perf-audit';mkdirSync(out,{recursive:true})
const app=await _electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+root+'/userData'],env:{...process.env,DSH_HOME:root+'/home'}})
const nap=ms=>new Promise(r=>setTimeout(r,ms))
let p
try {
 p=await app.firstWindow();p.setDefaultTimeout(15000)
 const errors=[],requests=[]
 p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.dismiss())
 await app.evaluate(({BrowserWindow,nativeTheme})=>{nativeTheme.themeSource='light';BrowserWindow.getAllWindows()[0].setSize(1440,1000)})
 await p.locator('[data-lg-pages]').waitFor()
 await p.evaluate(()=>{
 // Exercise bubbles even where the normal compact view hides decoration.
 const fixtureStyle=document.createElement('style');fixtureStyle.textContent='.lgt-panels{grid-template-columns:1fr!important}.lgt-companion-slot{display:block!important}';document.head.append(fixtureStyle)
 const fetchOriginal=window.fetch.bind(window);window.perfRequests=[]
 const roles=['coordinator','analysis','planning','writing'],to=new Date().setHours(24,0,0,0),from=to-7*86400000,step=(to-from)/96
 const rows=roles.map((role,i)=>({role,requests:2,known:2,input:100*(i+1),output:10*(i+1),inputAllocation:{system:50*(i+1)},outputAllocation:{text:10*(i+1)}}))
 const timeline={version:1,period:'7d',from,to,step,buckets:Array.from({length:96},(_,i)=>({from:from+i*step,to:from+(i+1)*step,roles:rows}))}
 const totals=rows.map(row=>({...row,requests:192,known:192,input:row.input*96,output:row.output*96,inputAllocation:{system:row.inputAllocation.system*96},outputAllocation:{text:row.outputAllocation.text*96}}))
 window.fetch=async(input,init)=>{
  if(String(input).endsWith('api/lg/teams')){
   window.perfRequests.push({time:Date.now(),kind:'teams',options:JSON.parse(init.body)})
   return Response.json({ok:true,value:{catalog:['coordinator','analysis','planning','writing'].map(id=>({id,name:id,output:'合成性能测试',description:'仅在 LitIsLand 中使用'})),tasks:[],roles:[],monitoring:{roles:totals,series:[],omitted:0,timeline}}})
  }
  if(!String(input).endsWith('api/lg/books')||!init?.body)return fetchOriginal(input,init)
  const body=JSON.parse(init.body)
  if(body.action!=='story-data')return fetchOriginal(input,init)
  window.perfRequests.push({time:Date.now(),options:body.options})
  const all=Array.from({length:36},(_,i)=>({id:'person:'+i,type:'entity',title:'测试人物'+i,summary:'合成人物的说明，用于宽度变化时测试文字换行与卡片排版。'.repeat(3),revision:'revision-'+i,payload:{name:'测试人物'+i,entity_kind:'character',description:'这是一位用于隔离性能测试的人物，经历过不同事件，需要在不同宽度下显示其简介。'.repeat(2),aliases:[]},scope:{targets:[],description:''},story_time:{kind:'unknown'},evidence:[],links:[],related_changed:[],approval:'candidate',freshness:'current',display:{character_portrait:null}}))
  const {offset=0,limit=8}=body.options??{}
  return Response.json({ok:true,value:{api_version:'lg.story-data.read.v1',book_id:'synthetic-perf',data_revision:'a'.repeat(64),chapters:[],entities:[],runs:[],records:all.slice(offset,offset+limit),total:all.length,offset,limit,catalog:{},counts:{portrait:0},directory:{}}})
 }
 })
 if(await p.locator('[data-sidebar-opener]').isVisible())await p.locator('[data-sidebar-opener]').click()
 await p.getByRole('button',{name:'Global Dashboard',exact:true}).click()
 await p.locator('.lgg-book-link').first().click()
 await p.getByRole('button',{name:'Characters',exact:true}).click()
 await p.locator('.lgd-person-row').first().waitFor()
 await p.getByRole('button',{name:'Global Dashboard',exact:true}).click({button:'right'})
 await p.getByRole('menuitem',{name:/^(打开方式|Open in)$/}).hover()
 await p.getByRole('menuitem',{name:/^(分栏打开|Split view)$/}).click()
 await p.locator('[data-dockkit-divider]').waitFor({state:'attached'})
 await p.locator('.lgd-people-collection').scrollIntoViewIfNeeded()
 console.log('Ready: real shell, book characters + Global Dashboard, synthetic records')
 const cdp=await p.context().newCDPSession(p)
 await cdp.send('Performance.enable')
 const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]))
 const results=[]
 await p.locator('.lgt-companion-slot').waitFor()
 await p.locator('.stb-col[data-side="input"]').first().waitFor()
 assert.equal(await p.locator('.stb-group').count(),5)
 const tokenTotal=()=>p.locator('.stb-group[data-group="all"] .stb-col').evaluateAll(els=>els.reduce((n,e)=>n+Number(e.dataset.total),0))
 const beforeTotal=await tokenTotal()
 assert.ok(beforeTotal>0)
 await nap(1500)
 console.log('Full global dashboard including synthetic Agent charts and companions')
 const slot=p.locator('.lgt-companion-slot'),companions=p.locator('.lgt-companions')
 await slot.scrollIntoViewIfNeeded()
 await p.waitForFunction(()=>document.querySelector('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)'))
 await nap(600)
 const originalWidth=await slot.evaluate(el=>el.style.width),box=await slot.boundingBox()
 await p.mouse.move(box.x+4,box.y+4);await p.mouse.down()
 for(const delta of [30,70,45]){await slot.evaluate((el,width)=>el.style.width=width+'px',box.width-delta);await nap(30)}
 await nap(350)
 assert.equal(await companions.getAttribute('data-resizing'),'','holding the pointer must keep optimization suspended')
 assert.ok(await companions.locator('.lgt-bubble-row').evaluate(el=>[...el.style.gridTemplateColumns.matchAll(/([.\d]+)fr/g)].every(m=>Number(m[1])<1)),'drag uses proportional lanes')
 await p.mouse.up()
 await p.waitForFunction(()=>!document.querySelector('.lgt-companions').hasAttribute('data-resizing'))
 assert.ok(await companions.locator('.lgt-bubble-row').evaluate(el=>[...el.style.gridTemplateColumns.matchAll(/([.\d]+)fr/g)].every(m=>Number(m[1])>1)),'optimization resumes after release')
 await nap(500)
 const bubbles=await companions.locator('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)').evaluateAll(els=>els.map(b=>{
  const root=b.closest('.lgt-companions'),a=root.querySelectorAll('.lgt-companion img')[Number(b.dataset.avatarIndex)].getBoundingClientRect(),r=b.getBoundingClientRect(),lane=b.parentElement.getBoundingClientRect()
  const tail=parseFloat(getComputedStyle(b).getPropertyValue('--lgt-tail-offset'))
  return {inside:r.left>=lane.left-1&&r.right<=lane.right+1,tail:Math.abs(r.left+r.width/2+tail-a.left-a.width/2)}
 }))
 assert.ok(bubbles.length&&bubbles.every(b=>b.inside&&b.tail<1.5),'settled bubbles stay inside their lanes and point at the avatar')
 const assets=await p.locator('.lgt-avatar,.lgt-companion img').evaluateAll(els=>els.map(el=>({width:el.naturalWidth,height:el.naturalHeight,display:el.clientWidth})))
 assert.equal(assets.length,10)
 assert.ok(assets.every(a=>a.width===a.height&&a.width>=a.display*3&&a.width<=162),'small avatars retain 3x display resolution')
 await slot.evaluate((el,width)=>el.style.width=width,originalWidth);await nap(300)
 console.log('PASS: search suspended while dragging, resumed after release; bubble bounds/tails and small avatars')

 for(const variant of ['normal']){
  await p.emulateMedia({reducedMotion:'no-preference'})
  for(const mode of ['split','sidebar','window']){
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000))
   await nap(500)
   const requestStart=await p.evaluate(()=>window.perfRequests.length)
   await p.evaluate(()=>{window.perfFrames=[];window.perfRunning=true;let last=0;const sample=t=>{if(last)window.perfFrames.push(t-last);last=t;if(window.perfRunning)requestAnimationFrame(sample)};requestAnimationFrame(sample)})
   const before=await metrics()
   const handle=mode==='window'?null:await p.locator(mode==='split'?'[data-dockkit-divider]':'[data-side="sidebar"]').evaluate(e=>e.getBoundingClientRect().toJSON())
   if(handle){await p.mouse.move(handle.x+handle.width/2,500);await p.mouse.down()}
   for(let i=0;i<90;i++){
    const phase=Math.sin(i/89*Math.PI*2)
    if(mode==='window')await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),Math.round(1320+160*phase))
    else await p.mouse.move(handle.x+handle.width/2+(mode==='split'?210:70)*phase,500)
    await nap(16)
   }
   if(handle)await p.mouse.up()
   await nap(220)
   const after=await metrics()
   const frames=await p.evaluate(()=>{window.perfRunning=false;return window.perfFrames})
   const sorted=frames.slice().sort((a,b)=>a-b)
   const row={variant,mode,frames:frames.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],over25ms:frames.filter(n=>n>25).length,max:Math.max(...frames),requests:await p.evaluate(()=>window.perfRequests.length)-requestStart}
   for(const key of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'])row[key]=(after[key]??0)-(before[key]??0)
   row.teamRequests=await p.evaluate(start=>window.perfRequests.slice(start).filter(r=>r.kind==='teams').length,requestStart)
   if(handle)assert.ok(row.teamRequests<=2,'a held drag only requests its final capacity, plus a possible periodic refresh')
   results.push(row);console.log(JSON.stringify(row))
  }
 }
 assert.equal(await tokenTotal(),beforeTotal,'resizing preserves timeline totals')
 assert.ok(results.every(row=>row.LayoutCount<1800),'resize must not trigger thousands of candidate browser layouts')
 await p.screenshot({path:out+'/resize-scene.png'})
 await p.locator('[data-lg-pane-header]').last().locator('button').last().click()
 await checkPeopleReflow(p,p.locator('.lgd-people-collection'))
 assert.deepEqual(errors,[])
 console.log('PASS: immediate card widths, row transition/reversal, reduced motion; no renderer errors')
 writeFileSync(out+'/resize-results.json',JSON.stringify({results,errors,requests:await p.evaluate(()=>window.perfRequests)},null,2))
} catch(e){if(p){console.log((await p.locator('body').innerText()).slice(0,1800));await p.screenshot({path:out+'/resize-failure.png'})}throw e}
finally{await app.close()}
