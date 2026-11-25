import assert from 'node:assert/strict'
import {readFileSync,existsSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
const root=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR
assert.ok(root&&existsSync(join(root,'.dashboard-test-profile')));mkdirSync(out,{recursive:true})
const {_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const app=await _electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+root+'/userData'],env:{...process.env,DSH_HOME:root+'/home'}})
try{
 const win=await app.firstWindow();win.setDefaultTimeout(15000)
 const dashboard=win.getByRole('button',{name:/^(书架总览|Bookshelf|Global Dashboard)$/}).first()
 await dashboard.waitFor()
 // The synthetic profile has no Agent service. Supply display-only data in this
 // window, while rendering the real Dashboard and its existing preview records.
 await win.evaluate(()=>{
  const fetch=window.fetch,to=Date.now(),step=86400000,from=to-7*step
  const value={tasks:[],catalog:[{id:'analysis',name:'分析',output:'证据报告'},{id:'planning',name:'规划',output:'候选规划'},{id:'writing',name:'创作',output:'候选正文'}],monitoring:{roles:[],timeline:{version:1,period:'7d',from,to,step,buckets:Array.from({length:7},(_,i)=>({from:from+i*step,to:from+(i+1)*step,roles:[]}))}}}
  window.fetch=(input,...args)=>String(input).includes('api/lg/teams')?Promise.resolve(Response.json({ok:true,value})):fetch(input,...args)
 })
 await dashboard.click()
 await win.locator('.lgt-mode-tabs').waitFor();await win.setViewportSize({width:1450,height:1100})
 // For a LitIsLand preview, load the same stylesheets in their production order.
 if(process.env.LG_ISOLATED_CSS){
  const css=['global.css','analytics.css','team-panel.css']
   .map(name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8')).join('\n')
  await win.evaluate(css=>{const style=document.createElement('style');style.textContent=css;document.body.append(style)},css)
 }
 for(const width of [1163,1040,933,932,820,640,561,560,500,390,820]){
  await win.locator('.lgd-page').evaluate((el,width)=>{el.style.width=width+'px'},width)
  const geometry=await win.locator('.lgt-panels').evaluate(async el=>{
   await new Promise(requestAnimationFrame)
   const a=el.querySelector('.lgt-roster').getBoundingClientRect(),b=el.querySelector('.lgt-monitor').getBoundingClientRect()
   return {rosterFits:[...el.querySelectorAll('.lgt-role>summary,.lgt-companions')].every(node=>node.scrollWidth<=node.clientWidth+1),side:Math.abs(a.y-b.y)<1&&b.x>a.x,stack:b.y>=a.bottom,companions:getComputedStyle(el.querySelector('.lgt-companion-slot')).display,overflow:el.scrollWidth-el.clientWidth}
  })
  if(width>560){assert.ok(geometry.side,JSON.stringify({width,...geometry}));assert.notEqual(geometry.companions,'none')}
  else{assert.ok(geometry.stack);assert.equal(geometry.companions,'none')}
  assert.ok(geometry.rosterFits,JSON.stringify({width,...geometry}));assert.ok(geometry.overflow<=1,JSON.stringify({width,...geometry}))
  const seam=await win.locator('.lgg-page').evaluate(page=>{
   const bounds=selector=>page.querySelector(selector).getBoundingClientRect()
   const tiles=[...page.querySelectorAll('.lgg-metrics .lgd-metric')].map(tile=>tile.getBoundingClientRect())
   const roster=bounds('.lgt-roster'),monitor=bounds('.lgt-monitor')
   const edges=tiles.filter(tile=>tile.top===tiles[0].top)
   const split=edges.findIndex(tile=>Math.abs(tile.left-monitor.left)<0.1)
   const corners=[...page.querySelectorAll('.lgt-panels>.lgd-card,.lgt-companions,.lgg-metrics>.lgd-metric,.lgg-top-charts>.lgd-card')]
    .map(card=>getComputedStyle(card).borderRadius)
   return {aligned:split>0&&Math.abs(edges[split-1].right-roster.right)<0.1,radii:[...new Set(corners)]}
  })
  assert.equal(seam.radii.length,1,'Agent and summary card radii: '+seam.radii.join(', '))
  if(geometry.side)assert.ok(seam.aligned,'Align both edges of the Agent gutter with the metric gutter at '+width+'px')
  await win.locator('.lgt-panels').screenshot({path:join(out,'agent-layout-'+width+'.png')})
 }
 const book=win.locator('.lgg-book-progress');assert.equal(await book.locator('select').count(),0)
 assert.equal(await book.getByRole('group',{name:/^(Book Status|书架状态)$/}).locator('button').count(),3)
 const uniform=await win.locator('.lga-heat').evaluate(el=>{const b=[...el.children].map(c=>c.getBoundingClientRect());return Math.max(...b.map(r=>r.width))-Math.min(...b.map(r=>r.width))<.02&&b.slice(7).every((r,i)=>Math.abs((r.x-b[i].right)-(b[7].x-b[0].right))<.02)})
 assert.ok(uniform,'Activity columns have equal widths and gaps')
 console.log('PASS: Agent panels side by side at 1040/820/640, stacked with companions hidden at 500/390, restore on expansion, no overflow')
}finally{await app.close()}
