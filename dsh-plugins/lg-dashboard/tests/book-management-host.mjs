import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {previewCreation,initializeBook} from '../../lg-books/src/initialize.js'
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const stage=process.env.LG_DASHBOARD_TEST_ROOT,out=process.env.LG_PREVIEW_DIR
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'));mkdirSync(out,{recursive:true})
const dir=mkdtempSync(join(out,'host-book-')),path=join(dir,'Book'),name='Shelf lifecycle host check'
const booksDirectory=join(dir,'Books'),libraryDirectory=join(dir,'Library');mkdirSync(booksDirectory);mkdirSync(libraryDirectory)
const preview=previewCreation(path,name);const book=initializeBook({...preview,operation:randomUUID()})
let app,win
const workspace=()=>win.locator('[data-row-key^="workspace:"]').filter({hasText:name})
const launch=async()=>{app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}});win=await app.firstWindow();win.setDefaultTimeout(15000);win.on('pageerror',error=>console.log('PAGE ERROR:',error.message));await win.setViewportSize({width:1400,height:1100});await win.getByRole('button',{name:/^(书架总览|Bookshelf|Global Dashboard)$/}).first().dispatchEvent('click');if(!(await call({action:'shelf'})).booksPath){await call({action:'configure-directories',booksDirectory,libraryDirectory});await win.reload();await win.getByRole('button',{name:/^(书架总览|Bookshelf|Global Dashboard)$/}).first().dispatchEvent('click')}await win.locator('.lgg-book-progress').waitFor()}
const call=input=>win.evaluate(async input=>{const response=await fetch('api/lg/books',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!result.ok)throw Error(result.error);return result.value},input)
try{
 await launch();await call({action:'add',path})
 assert.ok((await call({action:'shelf'})).books.find(b=>b.path===path).workspaceId)
 await workspace().waitFor()
 await call({action:'archive',path,id:book.id,confirmed:true})
 await workspace().waitFor({state:'detached'})
 let state=await call({action:'shelf'});assert.equal(state.books.find(b=>b.path===path).archived,true);assert.equal(state.books.find(b=>b.path===path).workspaceId,undefined)
 await app.close();app=null;await launch()
 state=await call({action:'shelf'});assert.equal(state.books.find(b=>b.path===path).archived,true,'archive persists across a real host restart')
 const progress=win.locator('.lgg-book-progress');await progress.scrollIntoViewIfNeeded()
 await progress.getByRole('group',{name:/^(Book Status|书架状态)$/}).getByRole('button',{name:/^(Archived|已归档)$/}).click()
 await progress.getByRole('button',{name,exact:true}).waitFor()
 await progress.screenshot({path:join(out,'host-archived.png')})
 await call({action:'restore',path,id:book.id,confirmed:true})
 assert.ok((await call({action:'shelf'})).books.find(b=>b.path===path).workspaceId)
 await workspace().waitFor()
 await call({action:'remove',path,id:book.id,confirmed:true})
 await workspace().waitFor({state:'detached'})
 state=await call({action:'shelf'});assert.ok(!state.books.some(b=>b.path===path))
 await app.close();app=null;await launch()
 state=await call({action:'shelf'});assert.ok(!state.books.some(b=>b.path===path),'removal survives host restart')
 assert.ok(await win.locator('.lgg-book-progress').getByRole('button',{name:/新增书籍|Add Book/}).count())
 await call({action:'add',path});assert.ok((await call({action:'shelf'})).books.find(b=>b.path===path).workspaceId)
 await call({action:'remove',path,id:book.id,confirmed:true})
 console.log('PASS: real Cordis config saves, sidebar registration disappears/restores live, archive and remove survive App restart, archived book visible in Book Progress; only isolated synthetic book changed')
}catch(error){if(win){console.log((await win.locator('body').innerText()).slice(0,3000));await win.screenshot({path:join(out,'host-failure.png')})}throw error}finally{if(app)await app.close()}
