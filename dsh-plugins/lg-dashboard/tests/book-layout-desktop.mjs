// Run prepare-book-sections.mjs first: 37 chapters and 13 synthetic characters.
import assert from 'node:assert/strict'
import {existsSync,writeFileSync} from 'node:fs'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'))
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const app=await electron.launch({executablePath:process.env.LG_APP_EXECUTABLE,args:['--user-data-dir='+stage+'/userData'],
 env:{...process.env,DSH_HOME:stage+'/home'},timeout:20000})
let win
const errors=[],geometry=[]
try{
 win=await app.firstWindow();win.setDefaultTimeout(12000);win.on('pageerror',e=>errors.push(e.message))
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1420,1080))
 await win.getByRole('button',{name:'书架总览',exact:true}).click()
 const globalFont=await win.locator('.lgg-page .lgd-header h1').evaluate(e=>getComputedStyle(e).fontSize)
 await win.locator('.lgg-book-link').first().click()
 await win.locator('.lgd-book-page .lgd-header h1').waitFor()
 assert.equal(await win.locator('.lgd-book-page .lgd-header h1').evaluate(e=>getComputedStyle(e).fontSize),globalFont)
 assert.equal(await win.locator('.lgd-book-page .lgd-header select,.lgd-book-page .lgd-manage,.lgd-book-workspace').count(),0)
 assert.equal(await win.locator('.lgd-book-page').getByRole('button',{name:'管理作品',exact:true}).count(),0)
 const browser=win.locator('.lgd-browser'),rows=browser.locator('.lgd-chapter'),pager=browser.locator('.lgd-chapter-pager')
 await rows.first().waitFor();assert.equal(await rows.count(),10)
 async function aligned(){
  const value=await win.locator('.lgd-main-columns').evaluate(e=>{
   const left=e.querySelector('.lgd-progress-reference'),a=left.firstElementChild.getBoundingClientRect(),b=left.lastElementChild.getBoundingClientRect(),right=e.querySelector('.lgd-browser').getBoundingClientRect()
   return {top:a.top-right.top,bottom:b.bottom-right.bottom,height:right.height}
  })
  assert.ok(Math.abs(value.top)<1&&Math.abs(value.bottom)<1,JSON.stringify(value));geometry.push(value)
 }
 await aligned()
 for(let page=2;page<=4;page++){
  await pager.getByRole('button',{name:'下一页',exact:true}).click()
  assert.equal(await rows.count(),page===4?7:10)
  assert.match(await pager.innerText(),new RegExp(`${page} / 4`))
 }
 assert.equal(await pager.getByRole('button',{name:'下一页',exact:true}).isDisabled(),true)
 await browser.getByRole('searchbox').fill('第37章');assert.equal(await rows.count(),1);assert.match(await pager.innerText(),/1 \/ 1/)
 await browser.getByRole('searchbox').fill('')
 await win.locator('.lgd-bar-column').nth(15).click()
 assert.match(await pager.innerText(),/2 \/ 4/)
 assert.match(await browser.locator('.lgd-chapter-open').innerText(),/第16章/)
 await aligned()
 await pager.getByRole('button',{name:'上一页',exact:true}).click()
 await rows.first().locator('.lgd-chapter-head').click()
 await browser.getByText('第一章 旧码头 · v2',{exact:true}).waitFor()
 await aligned()
 await rows.first().locator('.lgd-chapter-head').click()
 const material=win.locator('.lgd-progress-reference>.lgd-card').last()
 await material.locator('summary').first().click();await aligned()
 await material.locator('summary').first().click()
 const colors=await win.locator('.lgd-page').evaluate(page=>{
  const probe=document.createElement('span');probe.style.color='var(--dsw-alias-brand-primary, #d97757)';page.append(probe)
  const theme=getComputedStyle(probe).color;probe.remove()
  return {theme,bar:getComputedStyle(page.querySelector('.lgd-bar-space i')).backgroundColor,
   ring:getComputedStyle(page.querySelector('.lgd-ring svg circle:nth-child(3)')).stroke}
 })
 assert.equal(colors.bar,colors.theme);assert.equal(colors.ring,colors.theme);assert.notEqual(colors.bar,'rgb(255, 156, 0)')
 await win.locator('.lgd-main-columns').screenshot({path:stage+'/book-layout-light.png'})
 const story=win.getByRole('region',{name:'故事资料',exact:true}),card=story.locator('.lgd-story-detail')
 assert.equal(await story.locator('.lgd-story-module').count(),3)
 assert.equal(await story.locator('.lgd-data-entry').count(),0)
 const paths=await story.locator('.lgd-module-title svg').evaluateAll(icons=>icons.map(e=>e.innerHTML))
 assert.equal(new Set(paths).size,3)
 assert.deepEqual(await story.locator('.lgd-module-title>span:first-of-type').allTextContents(),['Characters','Plot','Setting'])
 const typography=el=>{
  const {fontFamily,fontWeight,fontSize,lineHeight,letterSpacing}=getComputedStyle(el)
  return {fontFamily,fontWeight,fontSize,lineHeight,letterSpacing}
 }
 const reference=await win.locator('.lgd-card').filter({has:win.locator('.lgd-composition')}).first().locator('.lgd-section-head h2').first().evaluate(typography)
 for(const title of await story.locator('.lgd-module-title').all()){
  assert.deepEqual(await title.evaluate(typography),reference)
  assert.notEqual(await title.locator('svg').evaluate(el=>getComputedStyle(el).color),'rgb(107, 138, 111)')
 }
 assert.equal(await win.locator('.lgd-metric b').first().evaluate(e=>getComputedStyle(e).color),'rgb(107, 138, 111)')
 await story.screenshot({path:stage+'/story-sections-overview.png'})
 await win.locator('.lgd-header').scrollIntoViewIfNeeded()
 await win.locator('.lgd-book-page').screenshot({path:stage+'/book-dashboard-overview.png'})
 async function change(action,api='story-data'){
  const response=win.waitForResponse(r=>r.url().includes('api/lg/books')&&r.request().postDataJSON()?.action===api)
  await action();await response
  if(api==='story-data')await card.locator('.lgd-story-browser[aria-busy="false"]').waitFor()
  else await card.locator('.lgd-time-panel [role="status"]').waitFor({state:'hidden'})
 }
 await change(()=>story.getByRole('button',{name:'Characters',exact:true}).click())
 const layout=await story.locator('.lgd-story-modules').evaluate(el=>({width:el.clientWidth,cards:[...el.children].map(c=>({id:c.dataset.section,...Object.fromEntries(['top','width'].map(k=>[k,c.getBoundingClientRect()[k]]))}))}))
 assert.equal(layout.cards.length,3)
 assert.equal(layout.cards[2].id,'people')
 assert.ok(Math.abs(layout.cards[2].width-layout.width)<1)
 assert.ok(Math.abs(layout.cards[0].width-layout.cards[1].width)<1)
 assert.equal(layout.cards[0].top,layout.cards[1].top)
 assert.ok(layout.cards[2].top>layout.cards[1].top)
 assert.match(await card.locator('.lgd-person-row').first().innerText(),/阿远/)
 assert.match(await card.locator('.lgd-person-row').first().innerText(),/核心人物/)
 const collection=card.locator('.lgd-people-collection'),peopleCards=collection.locator('.lgd-person-row')
 assert.equal(await collection.getByRole('tab',{name:'Card view'}).getAttribute('aria-selected'),'true')
 assert.equal(await peopleCards.count(),6)
 const peoplePager=card.getByRole('navigation',{name:'资料分页'})
 const next=peoplePager.getByRole('button',{name:'下一页'}),previous=peoplePager.getByRole('button',{name:'上一页'})
 const ids=()=>peopleCards.evaluateAll(cards=>cards.map(el=>el.dataset.personId))
 const firstIds=await ids()
 const footprint=()=>story.evaluate(el=>el.nextElementSibling.getBoundingClientRect().top-el.getBoundingClientRect().top)
 const firstHeight=await footprint()
 const release=await win.evaluateHandle(()=>{
  const original=window.fetch,gate=Promise.withResolvers()
  window.fetch=async(input,init)=>{
   const response=await original(input,init)
   if(String(input).includes('api/lg/books')&&typeof init?.body==='string'){
    const request=JSON.parse(init.body)
    if(request.action==='story-data'&&request.options.offset===6)await gate.promise
   }
   return response
  }
  return ()=>{window.fetch=original;gate.resolve()}
 })
 try{
  await next.click()
  await card.locator('.lgd-story-browser[aria-busy="true"]').waitFor()
  assert.deepEqual(await ids(),firstIds,'waiting should keep the current page visible')
  assert.match(await peoplePager.innerText(),/1 \/ 3/)
  assert.equal(await footprint(),firstHeight,'the next module must stay in place')
 }finally{await release.evaluate(unblock=>unblock());await release.dispose()}
 await card.locator('.lgd-story-browser[aria-busy="false"]').waitFor()
 assert.match(await peoplePager.innerText(),/2 \/ 3/)
 assert.equal((await ids()).some(id=>firstIds.includes(id)),false)
 await change(()=>next.click())
 assert.equal(await peopleCards.count(),1)
 assert.equal(await footprint(),firstHeight,'the short last card page should keep the pager in place')
 await change(()=>previous.click())
 await change(()=>previous.click())
 assert.deepEqual(await ids(),firstIds)
 async function assertNoInnerScroll(){
  const inner=await card.evaluate(panel=>[panel,...panel.querySelectorAll('div,section,aside,article,nav,pre,ul')].
   filter(el=>el.getClientRects().length&&['auto','scroll'].includes(getComputedStyle(el).overflowY)).
   map(el=>el.className||el.tagName))
  assert.deepEqual(inner,[],'character content should scroll with the dashboard')
 }
 async function checkWheel(target){
  const canvas=win.locator('.lgd-book-page>.lgd-canvas')
  await target.evaluate(el=>el.scrollIntoView({block:'center'}))
  await target.hover()
  const before=await canvas.evaluate(el=>el.scrollTop)
  const delta=await canvas.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>100?80:-80)
  await win.mouse.wheel(0,delta)
  await canvas.evaluate((el,{before,delta})=>new Promise((resolve,reject)=>{
   const deadline=performance.now()+2000
   function check(){
    if((el.scrollTop-before)*Math.sign(delta)>1)return resolve()
    if(performance.now()>=deadline)return reject(new Error('Wheel over character content did not move the dashboard'))
    requestAnimationFrame(check)
   }
   check()
  }),{before,delta})
 }
 await assertNoInnerScroll()
 await checkWheel(peopleCards.first())
 const originalNodes=await peopleCards.elementHandles()
 for(const view of ['List view','Pack view','Card view','Pack view']){
  await collection.getByRole('tab',{name:view,exact:true}).click()
  assert.equal(await collection.getByRole('tab',{name:view,exact:true}).getAttribute('aria-selected'),'true')
  await assertNoInnerScroll()
  for(const node of originalNodes)assert.equal(await node.evaluate(el=>el.isConnected),true,'view switches retain card nodes')
 }
 assert.equal(await collection.locator('.lgd-person-guide button').count(),6)
 const firstName=await collection.locator('.lgd-pack-picker strong').innerText()
 if(await peopleCards.count()>1){
  await collection.getByRole('button',{name:'下一个人物',exact:true}).click()
  assert.notEqual(await collection.locator('.lgd-pack-picker strong').innerText(),firstName)
  await collection.getByRole('button',{name:'上一个人物',exact:true}).click()
 }
 await win.locator('.lgd-page').evaluate(el=>el.style.width='390px')
 const packGeometry=await collection.evaluate(el=>({bottom:el.querySelector('.lgd-pack-picker').getBoundingClientRect().bottom,guide:el.querySelector('.lgd-person-guide').getBoundingClientRect().top,overflow:el.scrollWidth-el.clientWidth}))
 assert.ok(packGeometry.guide>=packGeometry.bottom,'narrow Pack guide must not overlap the card/picker')
 assert.ok(packGeometry.overflow<=1)
 await assertNoInnerScroll()
 await checkWheel(collection.locator('.lgd-person-guide button').last())
 for(const view of ['List view','Card view']){
  await collection.getByRole('tab',{name:view,exact:true}).click()
  await assertNoInnerScroll()
 }
 await win.locator('.lgd-page').evaluate(el=>el.style.width='')
 await collection.getByRole('tab',{name:'List view',exact:true}).click()
 await collection.getByRole('tab',{name:'List view',exact:true}).press('ArrowRight')
 assert.equal(await collection.getByRole('tab',{name:'Card view'}).getAttribute('aria-selected'),'true')
 for(const node of originalNodes)await node.dispose()
 await card.screenshot({path:stage+'/people-list.png'})
 await change(()=>card.locator('.lgd-person-row').first().click())
 assert.equal(await card.getByRole('navigation',{name:'人物资料栏目'}).getByRole('button').count(),6)
 await card.screenshot({path:stage+'/person-detail.png'})
 await change(()=>card.getByRole('button',{name:'查看评级依据',exact:true}).click())
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/重要程度/)
 await assertNoInnerScroll()
 await checkWheel(card.locator('.lgd-data-entry[open] summary').first())
 await change(()=>card.getByRole('button',{name:'返回当前列表'}).click())
 await change(()=>card.getByRole('button',{name:'人物列表'}).click())
 await change(()=>card.getByLabel('当前资料排序').selectOption('references'))
 assert.match(await card.locator('.lgd-person-row').first().innerText(),/林澈/)
 await change(()=>card.locator('.lgd-person-row').first().click())
 for(const label of ['性格与侧写','人物认知','人物状态','人物关系']){
  await change(()=>card.getByRole('button',{name:label,exact:true}).click())
  assert.ok(await card.locator('.lgd-data-entry').count()>0,label)
 }
 await change(()=>card.getByRole('button',{name:'人物经历',exact:true}).click(),'story-time')
 assert.equal(await card.locator('.lgd-time-panel .lgd-data-entry').count(),8)
 await change(()=>card.getByRole('button',{name:'事件前后状态',exact:true}).click(),'story-time')
 await change(()=>card.getByLabel('经历参照事件').selectOption('event:injury'),'story-time')
 assert.match(await card.innerText(),/时间条件确定适用/)
 await story.getByRole('navigation',{name:'故事资料导航'}).getByRole('button',{name:'故事资料',exact:true}).click()
 await change(()=>story.getByRole('button',{name:'Plot',exact:true}).click(),'story-time')
 assert.equal(await card.locator('.lgd-time-panel .lgd-data-entry').count(),8)
 await card.getByRole('navigation',{name:'情节事件分页'}).getByRole('button',{name:'下一页'}).click()
 assert.equal(await card.locator('.lgd-time-panel .lgd-data-entry').count(),3)
 await card.screenshot({path:stage+'/plot-events.png'})
 await change(()=>card.getByRole('button',{name:'章节梗概',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 assert.match(await card.innerText(),/概括/)
 await change(()=>card.getByRole('button',{name:'伏笔与线索',exact:true}).click())
 assert.match(await card.innerText(),/父亲真实处境/)
 await change(()=>card.getByRole('button',{name:'节奏与情绪',exact:true}).click())
 assert.match(await card.innerText(),/尚未单独标注/)
 await change(()=>card.getByRole('button',{name:'情绪变化',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 await story.getByRole('navigation',{name:'故事资料导航'}).getByRole('button',{name:'故事资料',exact:true}).click()
 await change(()=>story.getByRole('button',{name:'Setting',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),2)
 await change(()=>card.getByRole('button',{name:'已向读者揭露',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 await change(()=>story.getByLabel('资料阅读范围').selectOption('2'))
 assert.equal(await card.locator('.lgd-data-entry').count(),0)
 await change(()=>story.getByLabel('资料阅读范围').selectOption(''))
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 await card.locator('.lgd-data-entry summary').first().click()
 await change(()=>card.getByRole('button',{name:'查看揭露依据 · 候选',exact:true}).click())
 assert.match(await card.locator('.lgd-data-entry[open]').innerText(),/相关记录/)
 await change(()=>card.getByRole('button',{name:'待核对',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),1)
 await change(()=>card.getByRole('button',{name:'未向读者揭露',exact:true}).click())
 assert.equal(await card.locator('.lgd-data-entry').count(),0)
 assert.match(await card.innerText(),/缺少揭露记录的内容保留/)
 await change(()=>card.getByRole('button',{name:'地点',exact:true}).click())
 assert.match(await card.innerText(),/旧码头/)
 await change(()=>card.getByRole('button',{name:'情节场景',exact:true}).click())
 assert.match(await card.innerText(),/守灯人收到来信/)
 await card.screenshot({path:stage+'/environment-scenes.png'})
 await win.locator('.lgd-page').evaluate(e=>{e.style.width='390px'})
 assert.ok(await win.locator('.lgd-page').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 assert.ok((await browser.boundingBox()).height<=600)
 await browser.screenshot({path:stage+'/chapter-progress-narrow.png'})
 await win.locator('.lgd-page').evaluate(e=>{e.style.width=''})
 await win.evaluate(()=>document.body.setAttribute('data-ds-dark-theme','dark'))
 await aligned()
 await win.locator('.lgd-main-columns').screenshot({path:stage+'/book-layout-dark.png'})
 assert.deepEqual(errors,[])
 writeFileSync(stage+'/layout-verification.json',JSON.stringify({synthetic:true,entry:'LiteraryGiant App',chapters:37,pageSizes:[10,10,10,7],geometry,colors,
  checks:['three section entrances','person drilldown','analysis filters','revelation evidence and unknowns','event pagination','native icons','sage accent','heading size','pagination','search reset','chart navigation','expanded details alignment','left height changes','theme accent','importance sorting','role evidence','reference sorting','existing timeline','390px','dark'],pageErrors:errors,modelCalls:0},null,2))
 console.log('PASS: book sections, scoped drilldown, evidence, native icons/sage color, 37-chapter pagination, aligned columns, narrow/dark')
}catch(error){if(win)await win.screenshot({path:stage+'/layout-failure.png'}).catch(()=>{});throw error}
finally{await app.close()}
