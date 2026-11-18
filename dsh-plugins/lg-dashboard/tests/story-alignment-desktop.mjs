// prepare-book-sections.mjs + prepare-story-alignment.mjs, in a fresh isolated profile.
import assert from 'node:assert/strict'
import {existsSync,writeFileSync} from 'node:fs'
import {readStoryData,importStoryData} from '../../lg-books/src/story-data/store.js'
import {contractHash} from '../../lg-books/src/story-data/validate.js'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'))
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'},timeout:20000})
let win
const errors=[]
try{
 win=await app.firstWindow();win.setDefaultTimeout(12000);win.on('pageerror',e=>errors.push(e.message))
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1420,1080))
 await win.getByRole('button',{name:'书架总览',exact:true}).click()
 await win.locator('.lgg-book-link').first().click()
 const story=win.getByRole('region',{name:'故事资料',exact:true}),card=story.locator('.lgd-story-detail')
 async function change(action,api='story-data'){
  const response=win.waitForResponse(r=>r.url().includes('api/lg/books')&&r.request().postDataJSON()?.action===api)
  await action();await response
  if(api==='story-data')await card.locator('.lgd-story-browser[aria-busy="false"]').waitFor()
  else await card.locator('.lgd-time-panel [role="status"]').waitFor({state:'hidden'})
 }
 const overview=()=>story.getByRole('navigation',{name:'故事资料导航'}).getByRole('button',{name:'故事资料',exact:true}).click()
 await change(()=>story.getByRole('button',{name:'Characters',exact:true}).click())
 const lin=card.locator('.lgd-person-row').filter({hasText:'林澈'})
 assert.match(await lin.innerText(),/阶段 · 重要人物/)
 assert.match(await lin.innerText(),/候选评级 · 主角/)
 assert.match(await lin.innerText(),/仅前 1—3 章/)
 await card.screenshot({path:stage+'/people-aligned.png'})
 await change(()=>lin.click())
 await change(()=>card.getByRole('button',{name:'人物认知',exact:true}).click())
 assert.match(await card.innerText(),/认知主题：father-status/)
 await card.locator('.lgd-data-entry>summary').filter({hasText:'林澈开始怀疑'}).click()
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/此前认知/)
 await card.screenshot({path:stage+'/knowledge-chain.png'})
 await change(()=>card.locator('.lgd-data-entry[open] dd').filter({has:win.getByRole('button',{name:'林澈相信父亲已死',exact:true})}).getByRole('button').click())
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/认知主题/)
 await change(()=>card.getByRole('button',{name:'人物状态',exact:true}).click())
 await card.locator('.lgd-data-entry>summary').filter({hasText:'右臂恢复'}).click()
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/此前状态/)
 await overview()
 await change(()=>story.getByRole('button',{name:'Plot',exact:true}).click(),'story-time')
 await card.locator('.lgd-data-entry>summary').filter({hasText:'伤口愈合'}).click()
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/相对 林澈摔伤 的结束：3 天/)
 assert.ok(await card.locator('.lgd-data-entry[open]').getByRole('button',{name:'林澈摔伤',exact:true}).count()>0)
 assert.ok(await card.locator('.lgd-time-warnings').count()>0)
 await change(()=>card.getByRole('button',{name:'读者揭示',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),8)
 assert.match(await card.innerText(),/人物陈述保留其来源/)
 const pager=card.getByRole('navigation',{name:'资料分页'})
 // Append a real revision to this explicitly synthetic book while the first page is open.
 const root=stage+'/Books/潮汐来信',page=readStoryData(root,{id:'revelation:extra-9'})
 const {revision,confirmed_revision,approval,freshness,related_changed,created_at,run_id,display,...record}=page.records[0]
 record.summary+='（分页修订验证）'
 const operation='pagination-'+Date.now()
 const coverage=record.evidence.map(({document_id,version_id,sha256})=>({document_id,version_id,sha256,status:'complete',note:'Synthetic pagination test'}))
 importStoryData(root,{schema:'lg.story-data.batch.v1',contract_hash:contractHash,book_id:page.book_id,branch:'main',operation,run:{id:operation,producer:'author',method:'Synthetic live revision'},coverage,records:[{record,expected_revision:revision}]})
 await pager.getByRole('button',{name:'下一页',exact:true}).click()
 await card.getByText('资料已更新，已回到第一页。',{exact:true}).waitFor()
 await card.locator('.lgd-story-browser[aria-busy="false"]').waitFor()
 assert.match(await pager.innerText(),/1 \/ 2/)
 assert.equal(await card.locator('.lgd-data-entry').count(),8)
 await change(()=>pager.getByRole('button',{name:'下一页',exact:true}).click())
 assert.match(await pager.innerText(),/2 \/ 2/)
 assert.equal(await card.locator('.lgd-data-entry').count(),3)
 await card.screenshot({path:stage+'/reader-revelations.png'})
 await overview()
 await change(()=>story.getByRole('button',{name:'Characters',exact:true}).click())
 await win.locator('.lgd-page').evaluate(e=>{e.style.width='390px'})
 assert.ok(await win.locator('.lgd-page').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 await card.screenshot({path:stage+'/people-aligned-narrow.png'})
 await win.evaluate(()=>document.body.setAttribute('data-ds-dark-theme','dark'))
 assert.ok(await win.locator('.lgd-page').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 assert.deepEqual(errors,[])
 writeFileSync(stage+'/alignment-verification.json',JSON.stringify({entry:'LiteraryGiant App',synthetic:true,pageErrors:errors,checks:['scoped identity and candidate label','knowledge topic and predecessor navigation','state predecessor','relative event title and link','timeline warnings','revelation pagination','source revision resets page','390px','dark'],modelCalls:0},null,2))
 console.log('PASS: scoped fields, state/knowledge links, relative anchors, revelations, revision change, narrow/dark')
}catch(error){if(win)await win.screenshot({path:stage+'/alignment-failure.png'}).catch(()=>{});throw error}
finally{await app.close()}
