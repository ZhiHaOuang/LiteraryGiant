import {build} from 'esbuild'
import {writeFile,mkdir} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const stage=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR
assert.ok(stage&&out&&existsSync(stage+'/.dashboard-test-profile'))
await mkdir(out,{recursive:true})
await build({entryPoints:[fileURLToPath(new URL('./usage-motion-fixture.jsx',import.meta.url))],outfile:out+'/usage-fixture.js',bundle:true,format:'iife',platform:'browser',loader:{'.css':'text'},nodePaths:[process.env.LG_REACT_MODULE_DIR,process.env.LG_REACT_DOM_MODULE_DIR].filter(Boolean),plugins:[{name:'fixture-icon-only',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'icons',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export {}'}))}}]})
await writeFile(out+'/usage-fixture.html','<!doctype html><meta charset="utf-8"><div id="root"></div><script src="usage-fixture.js"></script>')
let app
try{
 app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}})
 const next=app.waitForEvent('window')
 await app.evaluate(({BrowserWindow},file)=>{const w=new BrowserWindow({width:800,height:600,webPreferences:{backgroundThrottling:false}});void w.loadFile(file)},out+'/usage-fixture.html')
 const win=await next;win.setDefaultTimeout(12000);const errors=[];win.on('pageerror',e=>errors.push(e.message))
 const card=win.locator('.lgg-usage');await card.waitFor();await win.waitForTimeout(1100)
 assert.equal(await card.locator('.lgg-usage-col').count(),7)
 const tokens=card.locator('.lgg-usage-bar.lgg-usage-tokens'),cost=card.locator('.lgg-usage-bar.lgg-usage-cost')
 assert.deepEqual(await tokens.evaluateAll(els=>els.map(e=>+e.dataset.value)),[100,200,300,400,500,600,700])
 assert.equal(await cost.nth(2).getAttribute('data-value'),'unknown');assert.equal((await cost.nth(2).boundingBox()).height,0)
 assert.equal(await tokens.first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(217, 119, 87)')
 assert.equal(await cost.first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(107, 138, 111)')
 const plotHeight=await card.locator('.lgg-usage-cols').evaluate(e=>e.clientHeight)
 for(let i=0;i<7;i++)assert.ok(Math.abs((await tokens.nth(i).boundingBox()).height/plotHeight*100-Math.round((i+1)/7*100))<1)
 await card.locator('.lgg-usage-col').first().hover();await win.waitForTimeout(200)
 const firstX=await card.locator('.lgg-usage-ring').evaluate(e=>e.getBoundingClientRect().x)
 await card.locator('.lgg-usage-col').last().hover();await win.waitForTimeout(400)
 assert.ok(await card.locator('.lgg-usage-ring').evaluate(e=>e.getBoundingClientRect().x)>firstX)
 assert.match(await card.locator('.lgg-usage-tip').innerText(),/700/)
 assert.equal(await tokens.first().evaluate(e=>getComputedStyle(e).opacity),'1')
 await card.screenshot({path:out+'/last-seven-motion.png'})
 await win.getByRole('button',{name:'Change fixture'}).click();await win.waitForTimeout(1100)
 assert.equal(await tokens.last().getAttribute('data-value'),'2000');assert.equal(await cost.last().getAttribute('data-value'),'0.8')
 assert.equal(await tokens.first().evaluate(e=>getComputedStyle(e).transitionDuration.split(',')[0].trim()),'0.6s')
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='360px');await win.waitForTimeout(300)
 assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await card.screenshot({path:out+'/last-seven-narrow.png'})
 await win.emulateMedia({reducedMotion:'reduce'});assert.equal(await tokens.first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
 assert.deepEqual(errors,[])
 console.log('PASS: actual Last7 component with synthetic data: unchanged 7 paired values/scales, unknown cost, orange/sage, stagger/growth, spring hover, live update, narrow, reduced motion. Only host icon stubbed; no ledger writes.')
}finally{if(app)await app.close()}
