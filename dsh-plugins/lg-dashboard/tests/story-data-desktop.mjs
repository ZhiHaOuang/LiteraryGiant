// Disposable profile only: contains the synthetic story-data fixture plus >8 analysis records.
import assert from 'node:assert/strict'
import {existsSync,writeFileSync} from 'node:fs'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'),'Use an explicit synthetic profile')
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,
 args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'},timeout:20000})
let win
const errors=[]
try{
 win=await app.firstWindow();win.setDefaultTimeout(12000)
 win.on('pageerror',error=>errors.push(error.message))
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1420,1080))
 await win.getByRole('button',{name:'书架总览',exact:true}).click()
 await win.locator('.lgg-book-link').first().click()
 const card=win.locator('.lgd-story-data'),entries=card.locator('.lgd-data-entry')
 await entries.first().waitFor()
 assert.equal(await entries.count(),8)
 assert.ok(await card.locator('.lgd-data-group').count()>0)
 const change=async action=>{
  const response=win.waitForResponse(r=>r.url().includes('api/lg/books')&&r.request().postDataJSON()?.action==='story-data')
  await action();await response
  await card.getByRole('status').waitFor({state:'hidden'})
 }
 await change(()=>card.getByRole('button',{name:/情节梗概与分析/}).click())
 assert.equal(await entries.count(),8)
 const titles=await entries.locator('summary strong').allTextContents()
 assert.equal(new Set(titles).size,8)
 assert.equal(titles.includes('本章节奏'),false)
 await card.screenshot({path:stage+'/materials-light.png'})
 const height=await card.boundingBox()
 await change(()=>card.getByRole('button',{name:'下一页',exact:true}).click())
 assert.equal(await entries.count(),5)
 assert.match(await card.getByRole('navigation',{name:'故事资料分页'}).innerText(),/2 \/ 2/)
 await change(()=>card.getByRole('button',{name:/人物与实体/}).click())
 assert.equal(await entries.count(),2)
 assert.match(await entries.first().innerText(),/林澈/)
 assert.match(await card.getByRole('navigation',{name:'故事资料分页'}).innerText(),/1 \/ 1/)
 await entries.first().locator('summary').first().click()
 await entries.nth(1).locator('summary').first().focus()
 await win.keyboard.press('Enter')
 assert.equal(await card.locator('.lgd-data-entry[open]').count(),1)
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/阿远/)
 await card.getByRole('button',{name:'查看修订历史',exact:true}).last().click()
 await card.locator('.lgd-data-entry[open] .lgd-data-revisions').waitFor()
 await entries.nth(1).locator('summary').first().click()
 await card.screenshot({path:stage+'/entities-light.png'})
 await change(()=>card.getByLabel('实体类别',{exact:true}).selectOption('place'))
 assert.equal(await entries.count(),0)
 await change(()=>card.getByRole('button',{name:/情节梗概与分析/}).click())
 await change(()=>card.getByRole('searchbox',{name:'搜索故事资料'}).fill('不会存在的资料'))
 assert.equal(await entries.count(),0)
 await change(()=>card.getByRole('searchbox',{name:'搜索故事资料'}).fill(''))
 await change(()=>card.getByLabel('正文阅读范围',{exact:true}).selectOption('1'))
 assert.equal(await entries.count(),6)
 assert.ok((await entries.locator('.lgd-data-subtitle').allTextContents()).every(t=>t.includes('来源第 1 章')))
 await change(()=>card.getByLabel('正文阅读范围',{exact:true}).selectOption(''))
 await win.locator('.lgd-page').evaluate(e=>{e.style.width='390px'})
 assert.ok(await win.locator('.lgd-page').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 await card.screenshot({path:stage+'/materials-narrow.png'})
 await win.locator('.lgd-page').evaluate(e=>{e.style.width=''})
 await win.evaluate(()=>document.body.setAttribute('data-ds-dark-theme','dark'))
 await card.screenshot({path:stage+'/materials-dark.png'})
 assert.deepEqual(errors,[])
 writeFileSync(stage+'/ui-verification.json',JSON.stringify({entry:'LiteraryGiant App',synthetic:true,
  checks:['8 items/page','distinct titles','chapter groups','entity ranking','single expansion','keyboard','history','empty filter','filter resets page','chapter cutoff','390px','dark'],
  collapsedAnalysisHeight:height.height,pageErrors:errors,modelCalls:0},null,2))
 console.log('PASS: real App story-data navigation, pagination, ranking, evidence/history and responsive layout')
}catch(error){
 if(win)await win.screenshot({path:stage+'/ui-failure.png'}).catch(()=>{})
 throw error
}finally{await app.close()}
