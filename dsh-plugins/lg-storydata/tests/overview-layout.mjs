import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
// Build lg-storydata first. LG_PLAYWRIGHT_MODULE selects the existing Playwright installation.
const {chromium,_electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
import {emptyParts} from '../src/space-categories.js'
import {characterProtocol} from '../src/character-core.js'
import {protocolGuide} from '../src/protocol-guide.js'
import {plotGroups,environmentGroups} from '../src/plot-environment-protocol.js'
const plugins=new URL('../../',import.meta.url)
const req=createRequire(new URL('package.json',plugins))
const host=createRequire(new URL('../dsh/packages/client/ui-layout/package.json',plugins))
const client=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const {outputFiles}=await req('esbuild').build({stdin:{contents:`import React from 'react';import * as jsxRuntime from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';
function Pane({component:Component}){
  const [page,updatePage]=React.useState({title:'lg-storydata'})
  const [actions,setActions]=React.useState(null)
  if(location.search==='?standalone')return <Component/>
  return <><header data-lg-pane-header><span data-lg-page-title>{page.title}</span><div data-lg-header-actions ref={setActions}/></header>
    <Component page={page} updatePage={updatePage} pageChrome={{actions:node=>actions&&createPortal(node,actions)}}/></>
}
window.__ModuleLoader__={load:({factory})=>factory(id=>id==='react/jsx-runtime'?jsxRuntime:React).apply({slots:{inject:(n,fn)=>fn(),register:(opts,Component)=>{if(opts.name==='main')createRoot(document.querySelector('#root')).render(<Pane component={Component}/>)}}})}`,loader:'jsx',resolveDir:fileURLToPath(plugins)},
 bundle:true,write:false,alias:{react:req.resolve('react'),'react/jsx-runtime':req.resolve('react/jsx-runtime'),'react-dom':host.resolve('react-dom'),'react-dom/client':host.resolve('react-dom/client')}})
const version='lg.storydata.inventory.v1'
const books=['放开那个女巫 · 前100章续写实验','湖线之外','遗忘账单','潮汐来信 · 验证书稿'].map((name,i)=>({name,archived:!!i,path:'/book/'+i,main:i?0:11,records:i?0:411,
 groups:i?[]:[{module:'core@1.identity',facet:'name',section:'people',count:10},{module:'core@1.summary',facet:null,section:'plot',count:1}],
 extracted:i?[]:[{type:'event',approval:'candidate',count:411}]}))
let shelf=books,scans=0,plotAvailable=false
let extraTerms=[]
function fixtureProtocol(locale){
 const protocol=characterProtocol(locale)
 if(extraTerms.length)protocol.groups[0].facets[0].vocabulary=extraTerms.join('、')
 return protocol
}
function storageFixture(){
 const parts={...emptyParts(),manuscript:1024,main:1024},previous={...parts,main:1536,other:128},bookCount=shelf.filter(b=>!b.error).length
 const unavailable=shelf.filter(b=>b.error).map(b=>b.name),complete=bookCount>0&&!unavailable.length
 scans++
 return {version:'lg.storydata.space.v1',parts:bookCount?parts:emptyParts(),chapters:bookCount,bookCount,files:bookCount*10,unavailable,
   historyStatus:complete?'saved':'incomplete',plotAvailable,history:{
     chapter:complete?Array.from({length:100},(_,i)=>({position:i+1,parts,previous})):[],plot:plotAvailable?[{position:2,parts,previous}]:[]}}
}
const desktop=process.env.LG_APP_EXECUTABLE,stage=process.env.LG_DASHBOARD_TEST_ROOT
if(desktop)assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'),'Electron requires the isolated test profile')
const browser=desktop?await _electron.launch({executablePath:desktop,args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:stage+'/home'}})
 :await chromium.launch({executablePath:process.env.LG_CHROMIUM})
try{
 const page=desktop?await browser.firstWindow():await browser.newPage(),errors=[]
 await page.setViewportSize({width:1000,height:800})
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('http://storydata.test/**',async r=>{
   const u=new URL(r.request().url())
   if(u.pathname==='/host.js')return r.fulfill({contentType:'application/javascript',body:outputFiles[0].text})
   if(u.pathname==='/client.js')return r.fulfill({contentType:'application/javascript',body:client})
   if(u.pathname==='/api/lg/storydata'){
     const {action,path,options}=r.request().postDataJSON(),b=shelf.find(b=>b.path===path)
     if(action==='storage')return r.fulfill({json:{ok:true,value:storageFixture()}})
     if(action==='overview')assert.equal(options.includeArchived,true)
     const value=action==='overview'?{version,protocol:fixtureProtocol(options.locale),books:shelf,totals:{main:shelf.reduce((n,b)=>n+(b.main||0),0),records:shelf.reduce((n,b)=>n+(b.records||0),0)}}:{version,...b,items:options.module?[]:[{id:'fixture',module:'core@1.summary',section:'world',title:'Fixture',value:'Example',tags:[]},{id:'plot-fixture',module:'core@1.summary',section:'plot',title:'Fixture Plot',value:'Example',tags:[]}],packs:[{id:'core',version:1,modules:{relationships:['people']}}],total:options.module?0:2,limit:30,offset:0}
     return r.fulfill({json:{ok:true,value}})
   }
   return r.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{margin:0;--dsw-alias-bg-base:#f5f6f8;--dsw-alias-bg-layer-1:white;--dsw-alias-bg-layer-2:#edf0f3;--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#ddd}#root{height:100vh}</style><div id="root"></div><script src="/host.js"></script><script src="/client.js"></script>'})
 })
 await page.goto('http://storydata.test')
 const metrics=page.locator('.lg-data-kpis'),space=page.locator('.lg-space')
 const header=page.locator('[data-lg-pane-header]'),refreshButton=header.getByRole('button',{name:'Refresh',exact:true})
 const chart=space.getByRole('region',{name:'Storage Growth'}),legend=space.getByRole('group',{name:'Shared Storage Legend'})
 await chart.waitFor()
 assert.equal(await header.locator('[data-lg-page-title]').textContent(),'Story Data')
 assert.equal(await page.locator('main h1').count(),0)
 assert.equal(await page.getByRole('button',{name:/^(Overview|Book Usage)$/}).count(),0)
 assert.equal(await legend.count(),1)
 assert.deepEqual(await metrics.locator('dt').allTextContents(),
   ['Books','Chapters','Active Books','Archived Books','Book Files','Main Entries','Characters','Plots','Environment','Extracted Records'])
 const metricValue=label=>metrics.locator(':scope > div').filter({has:page.getByText(label,{exact:true})}).locator('dd')
 assert.equal(await metricValue('Active Books').textContent(),'1')
 assert.equal(await metricValue('Archived Books').textContent(),'3')
 for(const name of ['Characters','Plots','Environment']) {
   assert.equal(await metrics.locator('dt').getByText(name,{exact:true}).count(),1)
   assert.equal(await legend.getByLabel(new RegExp('^'+name+' ·')).count(),1)
 }
 assert.doesNotMatch(await page.locator('main').innerText(),/\bSetting\b|\bPlot\b(?! Thread)/)
 for(const name of ['Main Dossiers','Story Archives','Other Files'])assert.equal(await legend.getByLabel(new RegExp('^'+name+' ·')).count(),1)
 assert.equal(await space.locator('.lg-space-headline strong').textContent(),'2 KiB')
 await page.setViewportSize({width:1800,height:880})
 async function resize(width){
   await page.locator('#root').evaluate((e,w)=>{e.style.width=w+'px'},width)
 }
 for(const width of [1680,1200,830,675,620,390,280,210,830]){
   await resize(width)
   const refreshSize=await refreshButton.boundingBox()
   assert.equal(refreshSize.height,24)
   assert.ok(refreshSize.width>=40 && refreshSize.width<=65)
   const [m,c]=await Promise.all([metrics.boundingBox(),space.boundingBox()])
   if(width>=675){assert.ok(Math.abs(c.width/m.width-2)<.02);assert.equal(c.y,m.y)}
   else assert.ok(c.y>=m.y+m.height)
   const grid=await metrics.evaluate(e=>[getComputedStyle(e).gridTemplateColumns,getComputedStyle(e).gridTemplateRows].map(s=>s.split(' ').length))
   assert.deepEqual(grid,[2,5], 'metric grid at '+width)
   if(width===830){
     const cards=await metrics.locator(':scope > div').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()))
     assert.ok(cards.every(card=>card.height>=74 && card.height<=80),'Dashboard card height at '+width)
     assert.ok(Math.abs(cards[2].top-cards[0].bottom-9)<1,'Dashboard row gap')
   }
   for(const selector of ['main','.lg-data-kpis','.lg-space','.lg-space-legend','.lg-space-controls']){
     assert.ok(await page.locator(selector).evaluateAll(elements=>elements.every(e=>e.scrollWidth<=e.clientWidth+1)),selector+' overflows at '+width)
   }
   if(process.env.LG_PREVIEW_DIR && [830,390].includes(width))await page.locator('.lg-data-overview-top').screenshot({path:join(process.env.LG_PREVIEW_DIR,'preview-'+width+'.png')})
 }
 const usage=space.getByRole('region',{name:'Storage Usage'}),readout=usage.locator('.lg-space-headline')
 const getSize=async()=>[await usage.boundingBox(),await chart.boundingBox(),await legend.boundingBox()]
 await usage.locator('.lc-stacked-seg').first().hover()
 await readout.getByRole('img',{name:'50.0%'}).waitFor()
 assert.match(await readout.innerText(),/Manuscript · 1 KiB/)
 assert.equal(await space.getByRole('tooltip').count(),0)
 await header.hover()
 assert.equal(await readout.locator('strong').isVisible(),true)
 const before=await getSize()
 await usage.getByRole('button',{name:'Field'}).click()
 const after=await getSize()
 assert.equal(after[0].height-before[0].height,52)
 assert.equal(before[1].height-after[1].height,52)
 assert.equal(after[2].y,before[2].y)
 const dots=usage.locator('.lg-space-field [data-kind="main"] i')
 assert.equal(await dots.count()*2,await usage.locator('.lg-space-field i').count())
 await dots.first().hover()
 await readout.getByRole('img',{name:'50.0%'}).waitFor()
 assert.match(await readout.innerText(),/Main Dossiers · 1 KiB/)
 if(process.env.LG_PREVIEW_DIR)await page.locator('.lg-data-overview-top').screenshot({path:join(process.env.LG_PREVIEW_DIR,'preview-field.png'),animations:'disabled'})
 await header.hover()
 await legend.getByLabel(/^Characters ·/).focus()
 await readout.getByRole('img',{name:'0.0%'}).waitFor()
 await page.emulateMedia({reducedMotion:'reduce'})
 assert.equal(await usage.locator('.lg-meter-reel').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
 for(const width of [390,280,210,830]){
   await resize(width)
   const square=await usage.locator('.lg-space-field').evaluate(field=>{
     const cell=field.querySelector('i')
     const {width,height}=cell.getBoundingClientRect()
     return [width,height,getComputedStyle(cell).backgroundImage]
   })
   assert.deepEqual(square,[6,6,'none'],'Field square at '+width)
   assert.ok(await page.locator('main').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 }
 await usage.getByRole('button',{name:'Bar'}).click()
 await chart.getByRole('button',{name:'Delta'}).click()
 assert.ok(await chart.locator('.lg-space-stack.down i').count()>0)
 await chart.locator('.lg-space-stack.down i').last().hover()
 await chart.locator('.lg-space-caption').getByRole('img',{name:'20.0%'}).waitFor()
 await chart.getByRole('button',{name:'Plots'}).click()
 await chart.getByText('Waiting for plot segmentation.').waitFor()
 assert.equal(await chart.getByRole('img').count(),0)
 plotAvailable=true
 const prior=scans
 await refreshButton.click()
 await chart.getByRole('img',{name:/Plots · 2/}).waitFor()
 assert.ok(scans>prior)
 const catalog=page.getByRole('region',{name:'Information Protocol',exact:true})
 const views=catalog.getByRole('group',{name:'Protocol View'}),protocol=characterProtocol('zh')
 const layouts=catalog.getByRole('group',{name:'Protocol Layout'}),index=catalog.getByRole('group',{name:'分类总览'})
 const compact=layouts.getByRole('button',{name:'Compact'}),extend=layouts.getByRole('button',{name:'Extend'})
 const indexSection=name=>index.getByRole('group',{name,exact:true})
 const layoutIsRightmost=()=>layouts.evaluate(el=>
   Math.abs(el.getBoundingClientRect().right-el.closest('header').getBoundingClientRect().right)<=1)
 const directory=catalog.getByRole('radiogroup',{name:'一级分类'})
 const facets=catalog.getByRole('radiogroup',{name:'二级分类'})
 const detail=catalog.getByRole('region',{name:'细分说明'})
 const choice=(column,name)=>column.getByRole('radio',{name,exact:true})
 const terms=detail.getByRole('list',{name:'词项'}).getByRole('listitem')
 const headerStyle=e=>[getComputedStyle(e).borderBottomWidth,getComputedStyle(e.querySelector('h2')).fontSize,getComputedStyle(e.querySelector('h2')).fontWeight]
 assert.deepEqual(await catalog.locator('header').evaluate(headerStyle),await usage.locator('header').evaluate(headerStyle))
 assert.deepEqual(await views.getByRole('button').allTextContents(),['Characters','Plots','Environment'])
 assert.equal(await layouts.evaluate(el=>el.previousElementSibling?.getAttribute('aria-label')),'Protocol View')
 assert.ok(await layoutIsRightmost())
 assert.equal(await catalog.getByRole('button',{name:'Menu'}).count(),0)
 assert.equal(await catalog.locator('[aria-expanded],details').count(),0)
 for(const label of ['条目字段','审查规则'])assert.equal(await catalog.getByText(label,{exact:true}).count(),0)
 assert.equal(await directory.getByRole('radio').count(),8)
 assert.ok(await choice(directory,'身份与辨识').isChecked())
 assert.ok(await choice(facets,'名称与称谓').isChecked())
 await detail.getByRole('heading',{name:'名称与称谓',exact:true}).waitFor()
 const detailStyle=()=>detail.evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el.querySelector('h3'),'::before').backgroundColor])
 assert.deepEqual(await detailStyle(),['rgb(255, 255, 255)','rgb(217, 119, 87)'])
 const swatches=await directory.locator('i').evaluateAll(dots=>dots.map(dot=>getComputedStyle(dot).backgroundColor))
 assert.equal(new Set(swatches).size,8)
 await choice(directory,'身份与辨识').focus()
 await page.keyboard.press('Tab')
 assert.ok(await choice(facets,'名称与称谓').evaluate(input=>input===document.activeElement))
 await page.keyboard.press('ArrowDown')
 assert.ok(await choice(facets,'基本辨识').isChecked())
 await detail.getByRole('heading',{name:'基本辨识',exact:true}).waitFor()
 await choice(facets,'身份背景').hover()
 await detail.getByText(protocolGuide['core@1.identity'].background[1],{exact:true}).waitFor()

 // Each detail must belong to the selected facet, including the last facet of a group.
 for(const group of protocol.groups){
   await choice(directory,group.label).check()
   assert.deepEqual(await detailStyle(),['rgb(255, 255, 255)','rgb(217, 119, 87)'])
   assert.deepEqual(await facets.locator('label span').allTextContents(),group.facets.map(f=>f.label))
   for(const facet of group.facets){
     await choice(facets,facet.label).check()
     assert.equal(await detail.getByRole('heading').textContent(),facet.label)
     const [purpose,example]=protocolGuide[group.module][facet.id]
     assert.ok(await detail.getByText(purpose,{exact:true}).isVisible())
     assert.ok(await detail.getByText(example,{exact:true}).isVisible())
     const words=facet.vocabulary.replace(/^建议固定为/u,'').split(/[、；]/u).map(w=>w.trim()).filter(Boolean)
     assert.deepEqual(await terms.allTextContents(),words)
   }
 }
 assert.equal(await extend.getAttribute('aria-pressed'),'true')
 await compact.click()
 assert.equal(await detail.count(),0)
 assert.equal(await views.count(),0)
 assert.deepEqual(await index.getByRole('heading',{level:3}).allTextContents(),['Characters','Plots','Environment'])
 const peopleIndex=indexSection('Characters')
 assert.deepEqual(await peopleIndex.getByRole('heading',{level:4}).allTextContents(),protocol.groups.map(g=>g.label))
 for(const group of protocol.groups){
   const row=peopleIndex.getByRole('group',{name:group.label,exact:true})
   assert.deepEqual(await row.getByRole('button').allTextContents(),group.facets.map(facet=>facet.label))
 }
 // Resolve the computed CSS colour to RGBA, including color-mix(), in each host theme.
 for(const dark of [false,true]){
   await page.locator('body').evaluate((body,enabled)=>body.toggleAttribute('data-ds-dark-theme',enabled),dark)
   const fills=await index.locator('.lg-protocol-index-row').evaluateAll(rows=>{
     const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true})
     const pixel=color=>{
       ctx.clearRect(0,0,1,1)
       ctx.fillStyle=color
       ctx.fillRect(0,0,1,1)
       return Array.from(ctx.getImageData(0,0,1,1).data)
     }
     return rows.map(row=>{
       const styles=Array.from(row.querySelectorAll('button'),el=>getComputedStyle(el))
       const fill=styles[0].backgroundColor
       return {label:pixel(getComputedStyle(row.querySelector('i')).backgroundColor),tag:pixel(fill),
         uniform:styles.every(style=>style.backgroundColor===fill&&style.opacity==='1')}
     })
   })
   for(const {label,tag,uniform} of fills){
     assert.ok(uniform)
     assert.equal(tag[3],255,'tag fill must be opaque')
     assert.ok(label.slice(0,3).every((channel,i)=>dark?tag[i]<channel:tag[i]>=channel),'tag tint follows host theme')
   }
   assert.equal(new Set(fills.slice(0,protocol.groups.length).map(row=>row.tag.join(','))).size,8)
 }
 await page.locator('body').evaluate(body=>body.removeAttribute('data-ds-dark-theme'))
 for(const width of [1440,768,375,210]){
   await resize(width)
   assert.ok(await catalog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Compact overflows at '+width)
   assert.ok(await layoutIsRightmost(),'layout switch position at '+width)
   let bottom=-Infinity
   for(const [label,count] of [['Characters',40],['Plots',19],['Environment',18]]){
     const section=indexSection(label),box=await section.boundingBox()
     assert.ok(box.y>=bottom-1,'stacked '+label+' at '+width)
     bottom=box.y+box.height
     assert.equal(await section.getByRole('button').count(),count)
     assert.ok(await section.getByRole('button').last().isVisible())
   }
 }
 await resize(830)
 await extend.click()
 assert.ok(await choice(directory,'关键经历与变化').isChecked())
 for(const [view,group,id,guides] of [['Plots','情节资料字段','plot',plotGroups],['Environment','环境资料字段','world',environmentGroups]]){
   await compact.click()
   const section=indexSection(view)
   assert.equal(await compact.getAttribute('aria-pressed'),'true')
   assert.equal(await detail.count(),0)
   const colors=await section.locator('h4 i').evaluateAll(dots=>dots.map(dot=>getComputedStyle(dot).backgroundColor))
   assert.equal(new Set(colors).size,guides.length+1)
   assert.deepEqual(await section.getByRole('heading',{level:4}).allTextContents(),[...guides.map(g=>g.label),group])
   for(const guide of guides){
     assert.deepEqual(await section.getByRole('group',{name:guide.label,exact:true}).getByRole('button').allTextContents(),guide.facets.map(f=>f.label))
   }
   const jump=guides.at(-1).facets.at(-1)
   await section.getByRole('button',{name:jump.label,exact:true}).press('Enter')
   assert.equal(await extend.getAttribute('aria-pressed'),'true')
   assert.equal(await views.getByRole('button',{name:view,exact:true}).getAttribute('aria-pressed'),'true')
   assert.equal(await detail.getByRole('heading').textContent(),jump.label)
   assert.ok(await detail.evaluate(el=>el===document.activeElement))
   for(const guide of guides){
     await choice(directory,guide.label).check()
     for(const facet of guide.facets){
       await choice(facets,facet.label).check()
       assert.equal(await detail.getByRole('heading').textContent(),facet.label)
       assert.deepEqual(await terms.allTextContents(),facet.terms)
       assert.ok(await detail.getByText(facet.purpose,{exact:true}).isVisible())
       assert.ok(await detail.getByText(facet.example,{exact:true}).isVisible())
     }
   }
   await choice(directory,group).check()
   const radios=await facets.getByRole('radio').all()
   assert.equal(radios.length,Object.keys(protocolGuide[id]).length)
   for(const [index,[purpose,example]] of Object.values(protocolGuide[id]).entries()){
     await radios[index].check()
     assert.ok(await detail.getByText(purpose,{exact:true}).isVisible())
     assert.ok(await detail.getByText(example,{exact:true}).isVisible())
     assert.ok(await terms.count()>0)
   }
 }
 await views.getByRole('button',{name:'Characters'}).click()
 assert.ok(await choice(directory,'关键经历与变化').isChecked())
 await choice(directory,'身份与辨识').check()
 assert.ok(await choice(facets,'叙事定位').isChecked())
 await choice(facets,'名称与称谓').check()
 extraTerms=Array.from({length:64},(_,i)=>'称谓'+i)
 await refreshButton.click()
 await detail.getByText('称谓63',{exact:true}).waitFor()
 assert.equal(await terms.count(),64)
 for(const width of [1440,768,520,375,210]){
   await resize(width)
   assert.ok(await catalog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'overflow at '+width)
   const [left,middle,right]=await Promise.all([directory.boundingBox(),facets.boundingBox(),detail.boundingBox()])
   assert.ok(middle.x>=left.x+left.width-1&&left.y===middle.y,'selectors side by side at '+width)
   if(width>=768)assert.ok(right.x>=middle.x+middle.width-1&&right.y===middle.y,'three columns at '+width)
   else assert.ok(right.y>=Math.max(left.y+left.height,middle.y+middle.height)-1,'stacked detail at '+width)
   const list=await detail.getByRole('list').boundingBox(),last=await terms.last().boundingBox()
   assert.ok(last.x+last.width<=list.x+list.width+1 && last.y+last.height<=list.y+list.height+1)
 }
 await resize(375)
 await page.emulateMedia({reducedMotion:'reduce'})
 const cdp=await page.context().newCDPSession(page)
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
 async function tap(control){
   await control.scrollIntoViewIfNeeded()
   const {x,y,width,height}=await control.boundingBox()
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x+width/2,y:y+height/2}]})
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
 }
 await tap(choice(directory,'目标与动机'))
 await tap(choice(facets,'驱动力'))
 await detail.getByText(protocolGuide['core@1.goals'].driver[1],{exact:true}).waitFor()
 assert.equal(await detail.locator('.lg-protocol-copy').evaluate(e=>getComputedStyle(e).animationName),'none')
 if(process.env.LG_PREVIEW_DIR)await catalog.screenshot({path:join(process.env.LG_PREVIEW_DIR,'columns-mobile.png')})
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false})
 await cdp.detach()
 await page.emulateMedia({reducedMotion:'no-preference'})
 await resize(830)
 extraTerms=[]
 await page.getByText('Book Records',{exact:true}).click()
 await page.getByLabel('Book',{exact:true}).selectOption(books[1].path)
 await page.getByRole('heading',{name:books[1].name,exact:true}).waitFor()
 await page.getByText('Environment / Summary',{exact:true}).waitFor()
 await page.getByText('Plots / Summary',{exact:true}).waitFor()
 await resize(280)
 await page.getByLabel('Module',{exact:true}).selectOption('core@1.relationships')
 await page.getByLabel('Category',{exact:true}).selectOption('obligation')
 await page.getByText('No reviewed entries match these filters.').waitFor()
 assert.ok(await page.locator('main').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
 plotAvailable=false
 shelf=[books[1],{path:'/bad',name:'暂时无法读取的作品',error:'文件不可读'}]
 await refreshButton.click()
 await space.getByText('Incomplete measurement · 暂时无法读取的作品').waitFor()
 await metricValue('Active Books').filter({hasText:/^0$/}).waitFor()
 assert.equal(await metricValue('Archived Books').textContent(),'1')
 shelf=[];await refreshButton.click();await space.getByText('No registered books to measure.').waitFor()
 await page.goto('http://storydata.test/?standalone')
 const fallback=page.locator('main header').filter({has:page.getByRole('heading',{name:'Story Data',exact:true})})
 await fallback.getByRole('button',{name:'Refresh',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(),1)
 assert.deepEqual(errors,[]);console.log('PASS')
}finally{await browser.close()}
