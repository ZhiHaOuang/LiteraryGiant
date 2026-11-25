import {build} from 'esbuild'
import {writeFile,mkdir} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const stage=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR
assert.ok(stage&&out&&existsSync(stage+'/.dashboard-test-profile'))
await mkdir(out,{recursive:true})
await build({entryPoints:[fileURLToPath(new URL('./dialogue-layout-fixture.jsx',import.meta.url))],outfile:out+'/dialogue-fixture.js',bundle:true,format:'iife',platform:'browser',loader:{'.css':'text','.png':'dataurl'},alias:{react:process.env.LG_REACT_MODULE_DIR+'/react','react-dom':process.env.LG_REACT_DOM_MODULE_DIR+'/react-dom'}})
await writeFile(out+'/dialogue-fixture.html','<!doctype html><meta charset="utf-8"><div id="root"></div><script src="dialogue-fixture.js"></script>')
let app,win
try{
 app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}})
 await app.firstWindow()
 const next=app.waitForEvent('window')
 await app.evaluate(({BrowserWindow},file)=>{const w=new BrowserWindow({width:800,height:600,webPreferences:{backgroundThrottling:false}});void w.loadFile(file)},out+'/dialogue-fixture.html')
 win=await next;win.setDefaultTimeout(15000);const errors=[];win.on('pageerror',e=>(errors.push(e.message),console.log('RENDER ERROR:',e.message)))
 const card=win.locator('.lgt-companions'),visible='.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)'
 const check=async count=>{
  await win.waitForFunction(({visible,count})=>document.querySelectorAll(visible).length===count,{visible,count});await win.waitForTimeout(600)
  const boxes=await card.locator(visible).evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {cy:r.top+r.height/2,x:r.left,right:r.right}}))
  assert.ok(Math.max(...boxes.map(b=>b.cy))-Math.min(...boxes.map(b=>b.cy))<1.5)
  for(let i=1;i<boxes.length;i++)assert.ok(boxes[i-1].right<=boxes[i].x)
  const tails=await card.locator(visible).evaluateAll(els=>els.map(b=>{const a=b.closest('.lgt-companions').querySelectorAll('.lgt-companion img')[+b.dataset.avatarIndex].getBoundingClientRect(),r=b.getBoundingClientRect();return Math.abs(r.left+r.width/2+parseFloat(getComputedStyle(b).getPropertyValue('--lgt-tail-offset'))-a.left-a.width/2)}))
  assert.ok(tails.every(n=>n<1.5));assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 }
 await win.waitForFunction(()=>document.querySelector('.lgt-companions')?.dataset.phase==='first');await win.waitForTimeout(500)
 const firstHeight=(await card.boundingBox()).height
 const avatarY=await card.locator('.lgt-avatar-groups').evaluate(e=>e.getBoundingClientRect().bottom)
 await check(2);assert.ok(Math.abs((await card.boundingBox()).height-firstHeight)<2)
 assert.ok(Math.abs(await card.locator('.lgt-avatar-groups').evaluate(e=>e.getBoundingClientRect().bottom)-avatarY)<1)
 const textFit=await card.locator(visible).evaluateAll(els=>els.map(el=>{
   const style=getComputedStyle(el),r=el.getBoundingClientRect(),rows=new Map(),text=el.querySelector('.lgt-bubble-text').firstChild
   for(let i=0;i<text.length;i++){const range=document.createRange();range.setStart(text,i);range.setEnd(text,i+1);const box=range.getBoundingClientRect(),y=Math.round(box.top);rows.set(y,Math.max(rows.get(y)??0,box.right))}
   const rights=[...rows.values()],expected=r.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth)
   const probe=el.cloneNode(true);probe.style.animation='none';probe.style.visibility='hidden';probe.style.width=(el.offsetWidth-1)+'px';el.parentElement.append(probe);const tight=probe.offsetHeight>el.offsetHeight;probe.remove()
   return {align:style.textAlign,last:style.textAlignLast,tight,edges:rights.slice(0,-1).map(x=>Math.abs(x-expected))}
  }))
 assert.ok(textFit.every(x=>x.align==='justify'&&x.last==='left'&&x.tight&&x.edges.every(d=>d<1.5)),JSON.stringify(textFit))
 await card.screenshot({path:out+'/balanced-two.png'})
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='320px');await check(2)
 await card.screenshot({path:out+'/balanced-two-narrow.png'})
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='440px')
 await win.getByRole('button',{name:'Three speakers'}).click();await check(3)
 assert.equal(await card.getAttribute('data-lanes'),'3')
 assert.deepEqual(await card.locator('.lgt-companion-pair').evaluateAll(els=>els.map(e=>e.querySelectorAll('.lgt-companion').length)),[3,3])
 assert.equal(await card.locator('[data-order="2"]').evaluate(e=>getComputedStyle(e).getPropertyValue('--lgt-bubble-tone').trim()),'#92959b')
 const padding=await card.evaluate(el=>{
  const r=el.getBoundingClientRect(),top=Math.min(...[...el.querySelectorAll('.lgt-comic-bubble:not([data-hidden]):not(.lgt-bubble-measure)')].map(e=>e.getBoundingClientRect().top)),bottom=Math.max(...[...el.querySelectorAll('.lgt-companion>span')].map(e=>e.getBoundingClientRect().bottom))
  return {top:top-r.top,bottom:r.bottom-bottom}
 });assert.ok(Math.abs(padding.top-padding.bottom)<1.5)
 assert.ok(await card.locator(visible).filter({hasText:'所谓英雄，不过疯子'}).evaluate(e=>e.offsetHeight===24))
 await card.screenshot({path:out+'/balanced-three.png'})
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='360px');await check(3)
 await card.screenshot({path:out+'/balanced-three-narrow.png'})
 await win.evaluate(()=>document.querySelector('.lgd-page').style.width='228px')
 await win.getByRole('button',{name:'Asymmetric dialogue'}).click()
 await win.waitForFunction(()=>[...document.querySelectorAll('.lgt-comic-bubble:not(.lgt-bubble-measure)')].some(e=>e.textContent.startsWith('我偶尔想你')))
 await check(3)
 const asymmetric=await card.locator(visible).evaluateAll(els=>els.map(el=>({width:el.offsetWidth,lines:(el.offsetHeight-10)/14,text:el.textContent})))
 assert.ok(asymmetric[0].text.startsWith('我偶尔想你')&&asymmetric[0].width>=100&&asymmetric[0].lines<=3,JSON.stringify(asymmetric))
 assert.ok(asymmetric.slice(1).every(b=>b.width<40&&b.lines===1),JSON.stringify(asymmetric))
 await card.screenshot({path:out+'/balanced-asymmetric.png'})
 await win.evaluate(()=>{const page=document.querySelector('.lgd-page');page.style.width='280px';page.style.height='500px'})
 await win.getByRole('button',{name:'Long dialogue'}).click()
 await win.waitForFunction(()=>[...document.querySelectorAll('.lgt-comic-bubble:not(.lgt-bubble-measure)')].some(e=>e.textContent.includes('再多等待')))
 await check(3)
 const clipped=card.locator('.lgt-comic-bubble:not(.lgt-bubble-measure) .lgt-bubble-text[data-clipped]')
 assert.equal(await clipped.count(),0,'ample space shows complete text')
 assert.ok(await card.locator(visible).evaluateAll(els=>els.some(e=>e.offsetHeight>80)),'long text is not limited to five lines')
 const anchored=await card.locator('.lgt-avatar-groups').evaluate(e=>e.getBoundingClientRect().bottom)
 await card.screenshot({path:out+'/long-full.png'})
 // Simulate expanded content above without moving the card bottom.
 await win.getByRole('button',{name:'Long dialogue'}).evaluate(e=>e.style.marginBottom='250px')
 await win.waitForTimeout(700)
 assert.ok(await clipped.count()>0)
 assert.ok(await clipped.evaluateAll(els=>els.every(e=>getComputedStyle(e).maskImage.includes('linear-gradient'))))
 assert.ok(Math.abs(await card.locator('.lgt-avatar-groups').evaluate(e=>e.getBoundingClientRect().bottom)-anchored)<1,'expanded content must not move avatars')
 const bounds=await card.evaluate(e=>({frame:e.getBoundingClientRect().top,slot:e.parentElement.getBoundingClientRect().top,cap:parseFloat(getComputedStyle(e).getPropertyValue('--lgt-bubble-text-height'))}))
 assert.ok(bounds.frame>=bounds.slot+7,'bubbles respect preceding content clearance')
 assert.notEqual(bounds.cap,70,'height is measured, not a fixed five lines')
 await card.screenshot({path:out+'/long-available-space.png'})
 await win.getByRole('button',{name:'Long dialogue'}).evaluate(e=>e.style.marginBottom='')
 await win.waitForTimeout(700)
 assert.equal(await clipped.count(),0)
 assert.ok(Math.abs(await card.locator('.lgt-avatar-groups').evaluate(e=>e.getBoundingClientRect().bottom)-anchored)<1)
 await win.emulateMedia({reducedMotion:'reduce'});await win.waitForTimeout(400)
 assert.equal(await card.locator(visible).count(),0);assert.deepEqual(errors,[])
 console.log('PASS: available-space clipping, stable avatar anchor, full long text when space permits, preplanned height, weighted two/three-lane widths, centered bubbles, aligned tails, two permanent avatar groups, independent speech lanes, gray third line, equal frame padding, narrow no overlap, reduced motion, zero page errors.')
}catch(error){if(win){console.log(await win.evaluate(()=>({url:location.href,ready:document.readyState,html:document.body.innerHTML.slice(0,1000)})));await win.screenshot({path:out+'/dialogue-failure.png'})}throw error}
finally{if(app)await app.close()}
