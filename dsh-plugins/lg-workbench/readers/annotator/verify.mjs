import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const {chromium} = await import(process.env.LG_PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.LG_CHROMIUM_EXECUTABLE,
})
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],requests=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()))
 await page.setContent('<iframe id="reader" sandbox="allow-scripts" style="width:100%;height:860px;border:0"></iframe>')
 await page.evaluate(html=>{
  window.messages=[]
  window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)messages.push(e.data)})
  document.querySelector('iframe').srcdoc=html
 },readFileSync(new URL('./preview.html', import.meta.url), 'utf8'))
 await page.waitForFunction(()=>messages.some(x=>x.type==='lg-reader:ready'))
 const chapter={type:'lg-reader:chapter',title:'第一章 · 雨夜',chapterId:'test-book/ch-1',text:'雨落在旧屋的瓦檐上，林远推开门，听见有人叫他的名字。\n\n桌上只有一封没有署名的信。'}
 const send=value=>page.evaluate(data=>document.querySelector('iframe').contentWindow.postMessage(data,'*'),value)
 await send(chapter)
 const frame=page.frameLocator('#reader')
 await frame.getByText('桌上只有一封没有署名的信。',{exact:true}).waitFor()
 assert.equal(await frame.getByRole('button',{name:'源码',exact:true}).count(),0)
 await frame.locator('.mdan-block').first().hover()
 await frame.getByRole('button',{name:'批注此块',exact:true}).first().click()
 await frame.getByPlaceholder('写下对这一处内容的修改意见…').fill('这里可以补充声音来自哪里。')
 await frame.getByRole('button',{name:'保存批注',exact:true}).click()
 await frame.locator('.mdan-card-text').filter({hasText:'这里可以补充声音来自哪里。'}).waitFor()
 await frame.getByRole('button',{name:'整理全部批注',exact:true}).click()
 await page.waitForFunction(()=>messages.some(x=>x.type==='lg-reader:quote'))
 const report=await page.evaluate(()=>messages.find(x=>x.type==='lg-reader:quote'))
 assert.equal(report.chapterId,chapter.chapterId);assert.match(report.text,/这里可以补充声音来自哪里/)
 await page.screenshot({path:'annotator-proof.png'})
 await send({...chapter,chapterId:'test-book/ch-2',title:'第二章',text:'次日，信已消失。'})
 await frame.getByText('次日，信已消失。',{exact:true}).waitFor()
 assert.equal(await frame.locator('.mdan-card-text').count(),0)
 await send(chapter)
 await frame.locator('.mdan-card-text').filter({hasText:'这里可以补充声音来自哪里。'}).waitFor()
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 const blocked=await frame.locator('body').evaluate(()=>new Promise(resolve=>{
  document.addEventListener('securitypolicyviolation',e=>resolve(e.effectiveDirective),{once:true})
  const image=new Image();image.src='https://example.invalid/reader-csp-probe';document.body.appendChild(image)
 }))
 assert.equal(blocked,'img-src')
 console.log('PASS CSP blocked external image; original annotator: chapter render, read-only toolbar, annotation create/rail/report, chapter isolation/return, no external requests or browser errors')
}finally{await browser.close()}
