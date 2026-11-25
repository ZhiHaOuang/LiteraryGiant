import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const out=process.env.LG_PREVIEW_DIR,profile=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(profile&&existsSync(join(profile,'.dashboard-test-profile')));mkdirSync(out,{recursive:true})
await build({entryPoints:[fileURLToPath(new URL('./controls-fixture.jsx',import.meta.url))],outfile:join(out,'controls.js'),bundle:true,format:'iife',platform:'browser',loader:{'.css':'text'},alias:{react:process.env.LG_REACT_MODULE_DIR+'/react','react-dom':process.env.LG_REACT_DOM_MODULE_DIR+'/react-dom'},plugins:[{name:'host-icon',setup(b){b.onResolve({filter:/icons\.jsx$/},()=>({path:'icons',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'import React from "react";export const Icon=()=>React.createElement("svg",{width:14,height:14});',resolveDir:process.cwd()}))}}]})
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(join(out,'controls.js')))}else{res.setHeader('content-type','text/html');res.end('<div id="root"></div><script src="/fixture.js"></script>')}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const {_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE);let app,win
try{
 app=await _electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+profile+'/userData'],env:{...process.env,DSH_HOME:profile+'/home'}})
 const host=await app.firstWindow();host.setDefaultTimeout(15000)
 const next=app.waitForEvent('window');await app.evaluate(({BrowserWindow},url)=>{const w=new BrowserWindow({width:1200,height:950});void w.loadURL(url)},'http://127.0.0.1:'+server.address().port)
 win=await next;win.setDefaultTimeout(10000);const errors=[];win.on('pageerror',e=>errors.push(e.message));await win.locator('.lgd-segment').first().waitFor()
 for(const width of [1100,700,440,320]){
  await win.setViewportSize({width,height:950})
  const result=await win.locator('main').evaluate(async el=>{
   await new Promise(requestAnimationFrame)
   const pair=[...el.querySelectorAll('.comparison .lgd-section-head')].map(n=>n.getBoundingClientRect())
   const segments=[...el.querySelectorAll('.lgd-segment button')].map(n=>{const b=n.getBoundingClientRect(),r=document.createRange();r.selectNodeContents(n);const text=r.getBoundingClientRect();return {height:b.height,center:Math.abs(text.y+text.height/2-b.y-b.height/2)}})
   return {overflow:el.scrollWidth-el.clientWidth,segments,aligned:Math.abs(pair[0].height-pair[1].height)<1&&(Math.abs(pair[0].y-pair[1].y)>1||Math.abs(pair[0].bottom-pair[1].bottom)<1),metadata:[...el.querySelectorAll('.lgd-meta-secondary')].map(n=>getComputedStyle(n).display),actions:[...el.querySelectorAll('.lgs-folder-controls>*')].map(n=>n.getBoundingClientRect().height),clippedHeaders:[...el.querySelectorAll('.lgd-section-head')].filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.innerText)}
  })
  assert.ok(result.overflow<=1,JSON.stringify({width,...result}));assert.ok(result.aligned,JSON.stringify({width,...result}));assert.equal(result.clippedHeaders.length,0,JSON.stringify({width,...result}))
  assert.ok(result.segments.every(s=>s.height===20&&s.center<=1),JSON.stringify({width,...result}));assert.ok(result.actions.every(h=>h===24))
  assert.ok(result.metadata.every(display=>width===1100?display!=='none':display==='none'))
  await win.screenshot({path:join(out,'controls-'+width+'.png')})
 }
 await win.getByRole('button',{name:'Requests',exact:true}).click();assert.equal(await win.locator('output').innerText(),'Requests')
 await win.getByRole('button',{name:'下一页',exact:true}).click();assert.match(await win.locator('.lgd-pager').innerText(),/2 \/ 3/)
 await win.getByRole('button',{name:'Rename Book',exact:true}).click();await win.getByRole('textbox',{name:'Book Title'}).fill('Temporary Draft');await win.getByRole('button',{name:'Cancel',exact:true}).click();assert.match(await win.locator('.lgd-book-title').innerText(),/放开那个女巫/)
 await win.getByRole('button',{name:'Set Folders',exact:true}).click();assert.equal(await win.evaluate(()=>window.openedFolders),true)
 await win.close();win=null
 await host.getByRole('button',{name:'Global Dashboard',exact:true}).first().click({button:'right'})
 await host.getByRole('menuitem',{name:/^(打开方式|Open in)$/i}).hover();await host.getByRole('menuitem',{name:/^(分栏打开|Split view)$/i}).waitFor()
 const menu=await host.evaluate(()=>{const rows=[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(n=>({text:n.innerText,rect:n.getBoundingClientRect().toJSON(),font:getComputedStyle(n).font,line:getComputedStyle(n).lineHeight,padding:getComputedStyle(n).padding}));return rows})
 writeFileSync(join(out,'menu.json'),JSON.stringify(menu,null,2))
 await host.screenshot({path:join(out,'menu.png')})
 const open=menu.find(n=>/^(打开方式|Open in)$/i.test(n.text.trim())),split=menu.find(n=>/^(分栏打开|Split view)$/i.test(n.text.trim()))
 assert.ok(open&&split,JSON.stringify(menu));assert.equal(open.rect.height,24);assert.equal(split.rect.height,24);assert.ok(Math.abs(open.rect.y-split.rect.y)<1,JSON.stringify(menu))
 await host.getByRole('menuitem',{name:/^(分栏打开|Split view)$/i}).click();assert.equal(await host.locator('[data-lg-pane-header]').count(),2)
 await host.locator('[data-row-key^="workspace:"]').first().click({button:'right'})
 await host.getByRole('menuitem',{name:/^(打开方式|Open in)$/i}).first().hover()
 await host.getByRole('menuitem',{name:/^(分栏打开|Split view)$/i}).waitFor()
 const workspaceMenu=await host.evaluate(()=>[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(n=>({text:n.innerText,rect:n.getBoundingClientRect().toJSON()})))
 assert.ok(workspaceMenu.every(n=>n.rect.height===24),JSON.stringify(workspaceMenu))
 await host.screenshot({path:join(out,'workspace-menu.png')})
 await host.keyboard.press('Escape');await host.keyboard.press('Escape')
 const rows=await host.locator('[data-row-key^="workspace:"],[data-row-key^="session:"]').evaluateAll(nodes=>nodes.map(n=>({height:n.getBoundingClientRect().height,font:getComputedStyle(n.querySelector('[data-dsh-claude-part~="row-title"]')).fontSize})))
 assert.ok(rows.length>1&&rows.every(n=>n.height===26&&n.font==='13px'),JSON.stringify(rows))
 assert.deepEqual(errors,[])
 console.log('PASS: controls / metadata at 1100, 700, 440, 320px; toggles, paging, rename cancel, folders; native Split View aligned and functional')
}catch(e){if(win)await win.screenshot({path:join(out,'failure.png')});throw e}finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve))}
