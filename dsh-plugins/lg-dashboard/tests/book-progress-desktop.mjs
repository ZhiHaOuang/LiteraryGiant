// Real author API + real React component; only the host icon is replaced in this isolated window.
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {apply} from '../../lg-books/index.js'
import {createBook} from '../../lg-books/tests/fixture.mjs'
const out=process.env.LG_PREVIEW_DIR;assert.ok(out);mkdirSync(out,{recursive:true})
const root=mkdtempSync(join(out,'books-test-')),booksDirectory=join(root,'Books'),libraryDirectory=join(root,'Library')
mkdirSync(booksDirectory);mkdirSync(libraryDirectory)
const original=join(booksDirectory,'Original');createBook(original).db.close()
const digest=()=>Object.fromEntries(readdirSync(original,{withFileTypes:true,recursive:true}).filter(e=>e.isFile()).map(e=>{const path=join(e.parentPath,e.name);return [path,createHash('sha256').update(readFileSync(path)).digest('hex')]}))
const before=digest(),routes=new Map(),services=new Map();let config={projects:[],booksDirectory,libraryDirectory}
const ctx={fiber:{entry:{}},configEditor:{async edit(entry,update){config=update(config);writeFileSync(join(root,'settings.json'),JSON.stringify(config))}},connection:{fetch:{register(route){routes.set(route.path,route);return()=>{}}}},get:name=>services.get(name),provide:(name,value)=>services.set(name,value),effect:fn=>fn(),inject:(deps,fn)=>fn(ctx)}
apply(ctx,config)
await build({entryPoints:[fileURLToPath(new URL('./book-progress-fixture.jsx',import.meta.url))],outfile:join(out,'fixture.js'),bundle:true,alias:{react:process.env.LG_REACT_MODULE_DIR+'/react','react-dom':process.env.LG_REACT_DOM_MODULE_DIR+'/react-dom'},format:'iife',platform:'browser',loader:{'.css':'text'},nodePaths:[process.env.LG_REACT_MODULE_DIR,process.env.LG_REACT_DOM_MODULE_DIR].filter(Boolean),plugins:[{name:'host-icon',setup(b){b.onResolve({filter:/icons\.jsx$/},()=>({path:'icons',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const Icon=()=>null;'}))}}]})
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/api/lg/books'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=await routes.get('/api/lg/books').fetch(new Request('http://local/api/lg/books',{method:'POST',body:Buffer.concat(chunks)}));res.writeHead(result.status,{'content-type':'application/json'});res.end(await result.text())}
  else if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(readFileSync(join(out,'fixture.js')))}
  else{res.writeHead(200,{'content-type':'text/html'});res.end('<div id="root"></div><script src="/fixture.js"></script>')}
 }catch(e){res.writeHead(500);res.end(e.message)}
});await new Promise(r=>server.listen(0,'127.0.0.1',r))
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE);let app,win;const errors=[]
try{
 const stage=process.env.LG_DASHBOARD_TEST_ROOT
 app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}})
 const next=app.waitForEvent('window');await app.evaluate(({BrowserWindow},url)=>{const w=new BrowserWindow({width:1100,height:800,webPreferences:{backgroundThrottling:false}});void w.loadURL(url)},'http://127.0.0.1:'+server.address().port)
 win=await next;win.setDefaultTimeout(10000);win.on('pageerror',e=>errors.push(e.message))
 const card=win.locator('.lgg-book-progress'),row=card.locator('tbody tr'),status=card.getByRole('group',{name:'Book Status'})
 await row.first().waitFor()
 assert.equal(await card.getByRole('searchbox').count(),0)
 assert.ok(await card.locator('th,td').evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).textAlign==='center')))
 assert.equal(await row.first().locator('.lgd-segment button').count(),2)
 await card.getByRole('button',{name:'Archive',exact:true}).click();await card.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(config.archivedProjects,undefined)
 await card.getByRole('button',{name:'Archive',exact:true}).click();await card.getByRole('button',{name:'Confirm Archive',exact:true}).click();await row.waitFor({state:'detached'})
 await status.getByRole('button',{name:'Archived',exact:true}).click();await row.waitFor();await card.getByRole('button',{name:'Restore',exact:true}).click();await card.getByRole('button',{name:'Confirm Restore'}).click();await row.waitFor({state:'detached'})
 await status.getByRole('button',{name:'Active',exact:true}).click();await row.waitFor()
 await card.getByRole('button',{name:'Remove',exact:true}).click();await card.getByRole('button',{name:'Confirm Remove'}).click();await row.waitFor({state:'detached'})
 assert.equal(services.get('literaryBooks').list().length,0)
 await win.reload();await card.waitFor();assert.equal(await row.count(),0)
 await card.getByRole('button',{name:'＋ Add Book'}).click();await card.getByRole('button',{name:'Add Existing',exact:true}).click();await card.getByLabel('Book Folder',{exact:true}).fill(original)
 await card.getByRole('button',{name:'Add to Shelf',exact:true}).click();await row.waitFor()
 await card.getByRole('button',{name:'＋ Add Book'}).click();await card.getByLabel('Book Name',{exact:true}).fill('UI New')
 await card.getByRole('button',{name:'Preview Creation'}).click();await card.getByRole('button',{name:'Confirm Creation'}).click()
 await win.waitForFunction(()=>document.querySelectorAll('tbody tr').length===2)
 assert.equal(services.get('literaryBooks').list().length,2)
 await card.screenshot({path:join(out,'book-management.png')})
 for(const width of [1000,800,600,390,280]){
  await win.setViewportSize({width,height:800})
  assert.ok(await card.locator('.lgg-book-table').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'table must fit without horizontal scroll')
  assert.ok(await row.first().getByRole('button',{name:'Archive',exact:true}).isVisible())
  assert.ok(await row.first().getByRole('button',{name:'Remove',exact:true}).isVisible())
  await card.screenshot({path:join(out,'book-responsive-'+width+'.png')})
 }
 await win.setViewportSize({width:800,height:800})
 await card.getByRole('button',{name:'＋ Add Book'}).click();await card.getByRole('button',{name:'Add Existing',exact:true}).click();await card.getByLabel('Book Folder',{exact:true}).fill(join(root,'Missing'))
 await card.getByRole('button',{name:'Add to Shelf',exact:true}).click();await card.getByRole('alert').waitFor();assert.equal(await row.count(),2)
 await win.setViewportSize({width:390,height:800});assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 await card.screenshot({path:join(out,'book-management-narrow.png')})
 assert.deepEqual(digest(),before);assert.deepEqual(errors,[])
 console.log('PASS: real API add/create, archive/restore, cancel, remove/reload/re-add, error retention, narrow layout; all original book files unchanged')
}catch(e){if(win){console.log('Fixture errors',errors);console.log((await win.locator('body').innerText()).slice(0,2000));await win.screenshot({path:join(out,'failure.png')})}throw e}finally{if(app)await app.close();await new Promise(r=>server.close(r))}
