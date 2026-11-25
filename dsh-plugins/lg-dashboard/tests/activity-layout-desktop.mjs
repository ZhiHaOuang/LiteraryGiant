import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync,existsSync,readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const out=process.env.LG_PREVIEW_DIR,profile=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(profile&&existsSync(join(profile,'.dashboard-test-profile')));mkdirSync(out,{recursive:true})
await build({entryPoints:[fileURLToPath(new URL('./activity-fixture.jsx',import.meta.url))],outfile:join(out,'activity-fixture.js'),bundle:true,format:'iife',platform:'browser',loader:{'.css':'text'},alias:{react:process.env.LG_REACT_MODULE_DIR+'/react','react-dom':process.env.LG_REACT_DOM_MODULE_DIR+'/react-dom'},plugins:[{name:'host-icon',setup(b){b.onResolve({filter:/icons\.jsx$/},()=>({path:'icons',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const Icon=()=>null;'}))}}]})
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(out,'activity-fixture.js')))}else{res.setHeader('content-type','text/html');res.end('<div id="root"></div><script src="/fixture.js"></script>')}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const {_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE);let app
try{
 app=await _electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+profile+'/userData'],env:{...process.env,DSH_HOME:profile+'/home'}})
 const next=app.waitForEvent('window');await app.evaluate(({BrowserWindow},url)=>{const w=new BrowserWindow({width:1200,height:600});void w.loadURL(url)},'http://127.0.0.1:'+server.address().port)
 const win=await next;win.setDefaultTimeout(10000);const errors=[];win.on('pageerror',error=>errors.push(error.message));await win.locator('.lga-heat button').first().waitFor()
 assert.equal(await win.locator('.lga-heat button').count(),371)
 assert.equal(await win.getByRole('button',{name:/Earlier|Newer/}).count(),0)
 assert.deepEqual(await win.locator('.lga-weekdays span').allTextContents(),['Mon','Wed','Fri','Sun'])
 assert.ok((await win.locator('.lga-months span').allTextContents()).every(label=>/^[A-Z][a-z]{2}$/.test(label)))
 assert.ok(!/[\u3400-\u9fff]/.test(await win.locator('main').innerText()),'English labels even with Chinese caller locale')
 for(const width of [1200,720,390,280]){
  await win.setViewportSize({width,height:600})
  const result=await win.locator('.lga-calendar').evaluate(async calendar=>{
   await new Promise(requestAnimationFrame)
   const cells=[...calendar.querySelectorAll('.lga-heat button')],bounds=cells.map(cell=>cell.getBoundingClientRect())
   const weekdays=[...calendar.querySelectorAll('.lga-weekdays span')]
   return {overflow:calendar.scrollWidth-calendar.clientWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth,uniform:Math.max(...bounds.map(b=>b.width))-Math.min(...bounds.map(b=>b.width))<.02&&bounds.slice(7).every((b,i)=>Math.abs((b.x-bounds[i].right)-(bounds[7].x-bounds[0].right))<.02),pixelAligned:Math.abs(bounds[0].width*devicePixelRatio-Math.round(bounds[0].width*devicePixelRatio))<.02,squares:bounds.every(b=>Math.abs(b.width-b.height)<1),aligned:weekdays.every((label,i)=>{const a=label.getBoundingClientRect(),b=bounds[i*2];return Math.abs(a.y+a.height/2-b.y-b.height/2)<1})}
  })
  assert.ok(result.overflow<=1&&result.pageOverflow<=1,JSON.stringify({width,...result}));assert.ok(result.squares);assert.ok(result.uniform);assert.ok(result.pixelAligned);assert.ok(result.aligned,JSON.stringify({width,...result}))
  await win.locator('.lgd-card').screenshot({path:join(out,'activity-'+width+'.png')})
 }
 await win.getByRole('button',{name:'Requests',exact:true}).click();assert.equal(await win.getByRole('button',{name:'Requests',exact:true}).getAttribute('aria-pressed'),'true')
 const day=win.locator('.lga-heat button:enabled').first();const key=(await day.getAttribute('aria-label')).slice(0,10);await day.click();assert.equal(await win.evaluate(()=>window.selectedDay),key)
 await win.getByRole('button',{name:'Sessions',exact:true}).click();assert.equal(await win.getByRole('button',{name:'Sessions',exact:true}).getAttribute('aria-pressed'),'true')
 assert.deepEqual(errors,[])
 console.log('PASS: 53 weeks, English labels, no pager/overflow at 1200/720/390/280px, square cells, weekday alignment, metric switch and date selection')
}finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve))}
