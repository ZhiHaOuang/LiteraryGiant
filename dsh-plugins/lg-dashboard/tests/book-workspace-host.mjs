import assert from 'node:assert/strict'
import {existsSync,mkdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
const {_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const stage=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'));mkdirSync(out,{recursive:true})
let app,win,path,book,previousDirectories,name='Workspace regression '+randomUUID().slice(0,6)
const call=input=>win.evaluate(async input=>{
 const r=await fetch('api/lg/books',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
 const text=await r.text();let result;try{result=JSON.parse(text)}catch{throw Error(r.status+': '+text.slice(0,500))}
 if(!r.ok||!result.ok)throw Error(r.status+': '+result.error);return result.value
},input)
const global=async()=>{await win.getByRole('button',{name:'Global Dashboard',exact:true}).first().click();await win.locator('.lgg-book-progress').waitFor()}
const launch=async()=>{
 app=await _electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}})
 win=await app.firstWindow();win.setDefaultTimeout(15000);await win.setViewportSize({width:1400,height:1100});await global()
}
const row=()=>win.locator('[data-row-key^="workspace:"]').filter({hasText:name})
const menu=async label=>{await row().click({button:'right'});await win.getByRole('menuitem',{name:label,exact:true}).click()}
const settle=async()=>{await win.waitForFunction(()=>!document.querySelector('[role="dialog"]'))}
try{
 await launch()
 const previous=await call({action:'shelf'})
 previousDirectories={booksDirectory:previous.booksPath,libraryDirectory:previous.libraryPath}
 const booksDirectory=join(out,'Books'),libraryDirectory=join(out,'Library');mkdirSync(booksDirectory,{recursive:true});mkdirSync(libraryDirectory,{recursive:true})
 const shelf=await call({action:'configure-directories',booksDirectory,libraryDirectory})
 assert.ok(shelf.booksPath.startsWith(stage),'synthetic Books directory only')
 path=join(shelf.booksPath,'workspace-regression-'+randomUUID())
 const preview=await call({action:'create-preview',path,name})
 book=await call({action:'create',path,name,token:preview.token,operation:randomUUID()})
 await row().waitFor()
 await menu(/^(Rename|重命名)$/)
 const dialog=win.getByRole('dialog');await dialog.getByRole('textbox').fill(name+' renamed')
 await dialog.getByRole('button',{name:/^(Rename|重命名)$/,exact:true}).click();await settle();name+=' renamed'
 await row().waitFor();assert.equal((await call({action:'read',path})).name,name)
 console.log('PASS: native workspace rename updates canonical book')
 await row().locator('[data-lg-book-link]').click();await win.locator('.lgd-book-info').waitFor()
 await win.getByRole('button',{name:/^(Rename Book|更改书名)$/}).click()
 const title=win.locator('.lgd-book-info');await title.getByRole('textbox').fill(name+' dashboard')
 const response=win.waitForResponse(async r=>r.url().endsWith('/api/lg/books')&&r.request().postDataJSON()?.action==='rename')
 await title.getByRole('button',{name:/^(Save|保存)$/}).click()
 const saved=await response;assert.equal(saved.status(),200,await saved.text());name+=' dashboard'
 await row().waitFor();assert.equal((await call({action:'read',path})).name,name)
 await win.locator('[data-lg-pane-header]').filter({hasText:name}).waitFor()
 console.log('PASS: Dashboard Rename Book saves, header and sidebar agree')
 await global();const progress=win.locator('.lgg-book-progress');await progress.getByRole('button',{name,exact:true}).waitFor()
 await call({action:'archive',path,id:book.id,confirmed:true});await row().waitFor({state:'detached'})
 await win.getByRole('button',{name:/^(Refresh|刷新)$/}).first().click()
 await progress.getByRole('button',{name,exact:true}).waitFor({state:'detached'})
 await progress.getByRole('button',{name:/^(Archived|已归档)$/,exact:true}).click();await progress.getByRole('button',{name,exact:true}).waitFor()
 const inventory=await win.evaluate(async()=>{const r=await fetch('api/lg/storydata',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'overview'})});return await r.json()})
 assert.equal(inventory.ok,true);assert.ok(!inventory.value.books.some(b=>b.path===path))
 await call({action:'restore',path,id:book.id,confirmed:true});await row().waitFor()
 console.log('PASS: archive hides active lists and Story Data; restore preserves canonical name')
 await menu(/^(Delete workspace|删除工作区)$/)
 await win.getByRole('dialog').getByRole('button',{name:/^(Delete workspace|删除工作区)$/,exact:true}).click();await settle()
 await row().waitFor({state:'detached'});assert.ok(!(await call({action:'shelf'})).books.some(b=>b.path===path))
 await app.close();app=null;await launch()
 assert.ok(!(await call({action:'shelf'})).books.some(b=>b.path===path),'directory rediscovery cannot undo removal after restart')
 assert.equal(JSON.parse(readFileSync(join(path,'.literarygiant/project.json'),'utf8')).name,name)
 await win.screenshot({path:join(out,'book-workspace-success.png')})
 console.log('PASS: native remove persists across refresh/restart and leaves book files intact')
}catch(error){if(win){console.log((await win.locator('body').innerText()).slice(-3500));await win.screenshot({path:join(out,'book-workspace-failure.png')})}throw error}finally{if(app){if(previousDirectories)await call({action:'configure-directories',...previousDirectories});await app.close()}}
