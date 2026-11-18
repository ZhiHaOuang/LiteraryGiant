const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict'
import {existsSync,mkdirSync} from 'node:fs'
const stage=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR??stage
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'),'Use a marked isolated test profile')
mkdirSync(out,{recursive:true});let app
try{
 app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'},timeout:15000})
 const win=await app.firstWindow();await win.setViewportSize({width:1600,height:1200});win.setDefaultTimeout(15000);const errors=[];win.on('pageerror',e=>errors.push(e.message))
 // Trigger the navigation handler directly: macOS can stall native clicks on a cold background test window.
 await win.getByRole('button',{name:/^(书架总览|Bookshelf)$/}).dispatchEvent('click')
 const monitor=win.locator('.lgt-monitor'),groups=monitor.locator('.lgt-time-groups'),summary=groups.locator('[data-group="all"]')
 await groups.waitFor()
 const chartStyles=await groups.locator('style').allTextContents()
 assert.equal(chartStyles.filter(css=>css.includes('.stb-plot')).length,1,'the five plots share one chart stylesheet')
 assert.equal(await win.locator('.lgg-controls').count(),0)
 assert.equal(await win.locator('.lgd-topbar input[type="date"]').count(),0)
 assert.equal(await win.locator('.lgd-topbar .lgg-period button').count(),6)
 assert.equal(await win.locator('.lgd-topbar').getByRole('button',{name:/^(Refresh|刷新)$/}).count(),0)
 assert.equal(await win.locator('.lgs-location-card').getByRole('button',{name:/^(Refresh|刷新)$/}).count(),1)
 assert.match(await monitor.innerText(),/文学 Agent 统计/)
 assert.ok(await win.locator('.lgd-topbar').evaluate(e=>parseFloat(getComputedStyle(e).paddingTop)>=20))
 assert.equal(await monitor.getByRole('button',{name:/30d test data/}).count(),0)
 assert.doesNotMatch(await monitor.innerText(),/所选档位 · 所选作品/)
 assert.equal(await monitor.locator('select').count(),0)
 assert.equal(await monitor.locator('.lgt-time-controls').count(),0)
 assert.deepEqual(await groups.locator('.lgt-bars-head').allTextContents(),['Summarizer','Lead','Analysis','Planning','Writing'])
 assert.equal(await groups.locator('.stb-axis').count(),0)
 assert.equal(await monitor.getByRole('button',{name:'Classic',exact:true}).count(),0)
 const presets=[['today','当天'],['24h','近24小时'],['7d','近7天'],['14d','近14天'],['30d','近30天'],['all','全部']]
 for(const [key,label] of presets){
  const response=win.waitForResponse(r=>r.url().includes('api/lg/teams')&&r.request().postDataJSON()?.period===key&&r.ok())
  await win.locator('.lgd-topbar').getByRole('button',{name:label,exact:true}).click();const body=await (await response).json()
  const expected=body.value.monitoring.roles
  await win.waitForFunction(({key,expected})=>[...document.querySelectorAll('.stb-group')].every(el=>el.dataset.period===key&&['input','output'].every(side=>{
   const roles=expected.filter(r=>el.dataset.group==='all'||r.role===el.dataset.group)
   return [...el.querySelectorAll(`.stb-col[data-side="${side}"]`)].reduce((s,e)=>s+(e.dataset.total==='unknown'?0:Number(e.dataset.total)),0)>=roles.reduce((s,r)=>s+r[side],0)
  })),{key,expected})
 }
 await groups.scrollIntoViewIfNeeded();await win.waitForTimeout(1100)
 const widths=await groups.locator('.stb-col').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().width));assert.ok(widths.every(w=>w>0&&w<7.1))
 const ringBox=await monitor.locator('.lgt-distribution').boundingBox(),plotBox=await groups.boundingBox();assert.ok(ringBox.x+ringBox.width<=plotBox.x)
 const half=await summary.boundingBox(),members=await groups.locator('.lgt-member-timelines').boundingBox()
 assert.ok(Math.abs(half.width-members.width)<1)
 const baselines=await groups.locator('.stb-base').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().top));assert.ok(Math.max(...baselines)-Math.min(...baselines)<1)
 const sumCount=await summary.locator('.stb-col[data-side="input"]').count()
 for(const role of ['coordinator','analysis','planning','writing'])assert.ok(await groups.locator(`[data-group="${role}"] .stb-col[data-side="input"]`).count()<=sumCount)
 const geometry=await groups.locator('.stb-group').evaluateAll(els=>els.flatMap(el=>{const y=el.querySelector('.stb-base').getBoundingClientRect().top;return [...el.querySelectorAll('.stb-col')].map(c=>({side:c.dataset.side,parts:[...c.querySelectorAll('.stb-bar')].map(p=>({top:p.getBoundingClientRect().top-y,bottom:p.getBoundingClientRect().bottom-y}))}))}))
 for(const c of geometry)for(const p of c.parts)assert.ok(c.side==='input'?p.bottom<0:p.top>0)
 for(const [label,mode] of [['Tokens','tokens'],['Context','context'],['Requests','requests'],['Duration','time']]){
  await monitor.getByRole('button',{name:label,exact:true}).click();await win.waitForTimeout(750)
  assert.equal(await groups.getAttribute('data-mode'),mode)
  assert.equal(await monitor.locator('.lgt-ring').count(),1)
  assert.equal(await groups.locator('.stb-group').count(),5)
  assert.equal(await groups.locator('.stb-col[data-side="output"]').count()>0,mode==='tokens')
  assert.equal(await monitor.locator('.lgt-bars-svg').count(),0)
  await monitor.screenshot({path:out+'/statistics-'+mode+'.png'})
 }
 await monitor.getByRole('button',{name:'Tokens',exact:true}).click();await win.waitForTimeout(750)
 await monitor.screenshot({path:out+'/agent-five-groups.png'})
 const small=groups.locator('[data-group="writing"]'),filled=small.locator('.stb-col[data-side="input"]').filter({has:win.locator('.stb-bar')}).first()
 await filled.hover();await win.waitForTimeout(300)
 assert.equal(await small.locator('.stb-ring').evaluate(e=>getComputedStyle(e).borderStyle),'dashed')
 const tooltip=await small.locator('.stb-tip').boundingBox(),bounds=await groups.boundingBox()
 assert.ok(tooltip.width>=200&&tooltip.x>=bounds.x-1&&tooltip.x+tooltip.width<=bounds.x+bounds.width+1)
 assert.match(await small.locator('.stb-tip-range').innerText(),/ – /)
 await monitor.screenshot({path:out+'/agent-five-hover.png'})
 await filled.locator('button').click();assert.ok(await small.locator('.stb-col[data-selected]').count()>=2)
 await filled.locator('button').press('Escape');await win.mouse.move(0,0)
 await win.locator('.lgd-topbar').screenshot({path:out+'/header.png'})
 assert.ok(await summary.locator('.stb-col[data-side="input"]').filter({has:win.locator('.stb-bar')}).count()>10)
 const baseline=await groups.evaluate(el=>({line:getComputedStyle(el,'::before').height,border:getComputedStyle(el.querySelector('.stb-group')).borderRightWidth,children:[...el.querySelectorAll('.stb-base')].map(b=>getComputedStyle(b).backgroundColor)}))
 assert.equal(baseline.line,'1px');assert.equal(baseline.border,'0px');assert.ok(baseline.children.every(c=>c==='rgba(0, 0, 0, 0)'))
 await monitor.screenshot({path:out+'/month-preview.png'})
 await win.setViewportSize({width:1100,height:1600});await win.evaluate(()=>document.querySelector('.lgd-page').style.width='390px');await win.waitForTimeout(1200)
 assert.ok(await groups.evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 assert.ok(await groups.locator('.stb-col').evaluateAll(els=>els.every(e=>e.getBoundingClientRect().width<7.1)))
 await monitor.screenshot({path:out+'/agent-five-narrow.png'})
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='')
 const companions=win.locator('.lgt-companions');await companions.scrollIntoViewIfNeeded()
 assert.deepEqual(await companions.locator('.lgt-companion>span').allTextContents(),['公主','青蛙','和摸伐','罗密欧','与','朱丽叶'])
 await win.waitForFunction(()=>{const root=document.querySelector('.lgt-companions');return root&&root.querySelectorAll('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)').length===Number(root.dataset.lanes)})
 await win.waitForTimeout(500)
 const tails=await companions.locator('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)').evaluateAll(els=>els.map(b=>{
  const a=b.closest('.lgt-companions').querySelectorAll('.lgt-companion img')[Number(b.dataset.avatarIndex)].getBoundingClientRect(),r=b.getBoundingClientRect(),offset=parseFloat(getComputedStyle(b).getPropertyValue('--lgt-tail-offset'))
  return Math.abs(r.left+r.width/2+offset-a.left-a.width/2)
 }))
 assert.equal(tails.length,Number(await companions.getAttribute('data-lanes')));assert.ok(tails.every(n=>n<1.5))
 await companions.screenshot({path:out+'/six-companions.png'})

 await win.setViewportSize({width:1600,height:1400})
 await win.evaluate(()=>{document.querySelector('.lgt-panels').style.gridTemplateColumns='minmax(0,1fr)'})
 for(const width of [1050,850,700,390]){
  await monitor.evaluate((e,w)=>e.style.width=w+'px',width);await win.waitForTimeout(900)
  for(const label of ['Tokens','Context','Requests','Duration']){
   await monitor.getByRole('button',{name:label,exact:true}).click();await win.waitForTimeout(650)
   const layout=await monitor.evaluate(el=>{
    const box=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,right:r.right,bottom:r.bottom}}
    const ring=el.querySelector('.lgt-ring'),group=el.querySelector('.lgt-time-groups'),legend=[...el.querySelectorAll('.lgt-ring-legend button')]
    return {ring:box(ring),plot:box(group),legend:legend.map(box),percent:legend.map(e=>getComputedStyle(e.querySelector('b')).display),kpis:[...el.querySelectorAll('.lgt-kpis>div')].map(e=>getComputedStyle(e).textAlign),edge:Math.max(...[...el.querySelectorAll('.lgt-sharebar')].map(e=>e.getBoundingClientRect().right)),charts:[...group.querySelectorAll('.stb-plot')].map(box),groupHeight:group.getBoundingClientRect().height,labels:[...group.querySelectorAll('.lgt-bars-head>span')].map(box),overflow:el.scrollWidth>el.clientWidth+1}
   })
   assert.ok(layout.ring.right<layout.plot.x,'donut stays left of chart at '+width)
   assert.ok(layout.kpis.every(a=>a==='center'))
   assert.ok(layout.labels.every(r=>r.right<=layout.edge+1),'headers stay inside lower content edge '+width+' '+label+' '+JSON.stringify(layout))
   assert.equal(layout.overflow,false)
   const titles=await groups.locator('.lgt-bars-head>span').evaluateAll(els=>els.map(e=>{const label=e.querySelector('.lgt-heading-text'),b=e.getBoundingClientRect(),r=label.getBoundingClientRect();return {center:Math.abs((r.top+r.bottom-b.top-b.bottom)/2),text:label.textContent,clipped:label.scrollWidth>label.clientWidth+1,fade:getComputedStyle(label).maskImage}}))
   assert.deepEqual(titles.map(t=>t.text),['Summarizer','Lead','Analysis','Planning','Writing'])
   assert.ok(titles.every(t=>t.center<1&&(!t.clipped||t.fade.includes('linear-gradient'))),'full labels centered vertically and clipped ends faded')
   assert.ok(layout.groupHeight<280,'five plots never grow into multiple rows')
   assert.ok(Math.max(...layout.charts.map(r=>r.y))-Math.min(...layout.charts.map(r=>r.y))<1,'all plots share a row')
   layout.labels.forEach((r,i)=>{const plot=layout.charts[i];assert.ok(Math.abs((r.x+r.right)/2-(plot.x+plot.right)/2)<1.5,'title centered on plot');if(i)assert.ok(r.x-layout.labels[i-1].right>=3,'title labels do not overlap')})
   assert.ok(layout.percent.every(v=>width>900?v!=='none':v==='none'))
   if(width<740){assert.ok(layout.legend.slice(0,2).every(r=>r.bottom<=layout.ring.y));assert.ok(layout.legend.slice(2).every(r=>r.y>=layout.ring.bottom))}
   if(label==='Tokens'||width===700)await monitor.screenshot({path:out+'/horizontal-'+width+'-'+label+'.png'})
  }
 }
 await monitor.evaluate(e=>e.style.width='')
 await win.evaluate(()=>document.querySelector('.lgt-panels').style.gridTemplateColumns='')
 await monitor.getByRole('button',{name:'Tokens',exact:true}).click()
 await win.emulateMedia({reducedMotion:'reduce'});await win.waitForFunction(()=>document.querySelector('.stb-group')?.hasAttribute('data-reduced'))
 assert.equal(await groups.locator('.stb-bar').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
 await win.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await monitor.screenshot({path:out+'/agent-five-dark.png'})
 assert.deepEqual(errors,[])
 console.log('PASS: four modes × four widths, persistent horizontal donut/chart, progressive legend compression, centered KPIs and aligned right edges; four metric rings+animated time groups, header range, relocated Refresh; six companions + measured tails, month test data retained without controls, shared line + top time controls; five groups, six real periods, role totals include complete real and test usage, half/half layout, shared baseline, thin adaptive bins, no x labels, bounded hover tooltip, selection, fixed single row with compact labels, reduced motion, dark, zero page errors.')
}finally{if(app)await app.close()}
