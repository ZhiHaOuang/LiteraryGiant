// Run against a disposable, credential-free App profile prepared with synthetic books.
// LG_DASHBOARD_TEST_ROOT must contain .dashboard-test-profile, home and home-baseline.
import assert from 'node:assert/strict'
import {existsSync,writeFileSync} from 'node:fs'
const stage=process.env.LG_DASHBOARD_TEST_ROOT
assert.ok(stage&&existsSync(stage+'/.dashboard-test-profile'),'An explicit synthetic test profile is required')
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const executablePath=process.env.LG_APP_EXECUTABLE
assert.ok(executablePath,'Use the existing LiteraryGiant App executable')

async function inspect(baseline) {
  const suffix=baseline?'-baseline':''
  const app=await electron.launch({executablePath,args:['--user-data-dir='+stage+'/userData'+suffix],
    env:{...process.env,DSH_HOME:!baseline&&process.env.LG_DASHBOARD_HOME||stage+'/home'+suffix},timeout:20000})
  let win
  try {
    win=await app.firstWindow();win.setDefaultTimeout(12000)
    await win.addInitScript(()=>{
      const original=window.fetch
      window.dashboardRequests=[]
      window.fetch=async(...args)=>{
        if(String(args[0]).includes('api/lg/books'))window.dashboardRequests.push(JSON.parse(args[1]?.body??'{}'))
        return original(...args)
      }
    })
    await win.reload()
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1420,1080))
    await win.getByRole('button',{name:'书架总览',exact:true}).click()
    const global=()=>win.getByRole('heading',{name:'全局 Dashboard',exact:true})
    await global().waitFor();await win.locator('.lgg-book-link').first().waitFor()
    assert.equal(await win.locator('.lgg-book-link').count(),2)
    const initial=await win.evaluate(()=>dashboardRequests.filter(r=>r.action==='shelf').length)
    // The independent onboarding slot may also load once; count main-view refresh separately.
    const usageBefore=await win.locator('.lgg-usage').innerText()
    const heatBefore=await win.locator('.lga-heat').innerHTML()
    await win.getByRole('button',{name:'近 30 天',exact:true}).click()
    assert.equal(await win.locator('.lgg-usage').innerText(),usageBefore)
    assert.equal(await win.locator('.lga-heat').innerHTML(),heatBefore)
    assert.equal(await win.locator('.lga-columns>button').count(),30)
    await win.getByRole('button',{name:'速度',exact:true}).click();await win.locator('.lga-speed').waitFor()
    await win.getByRole('button',{name:'Token 趋势',exact:true}).click()
    await win.locator('.lga-heat button:enabled').first().click()
    assert.equal(await win.locator('.lga-columns>button').count(),1)
    await win.getByRole('button',{name:'近 7 天',exact:true}).click()
    await win.getByRole('searchbox',{name:'搜索作品',exact:true}).fill('不存在')
    assert.equal(await win.locator('.lgg-book-link').count(),0)
    await win.getByRole('searchbox',{name:'搜索作品',exact:true}).fill('')
    const geometry=()=>win.locator('.lgd-metric,.lgg-usage,.lga-trend,.lgg-top-grid,.lga-heat button:first-child').evaluateAll(es=>es.map(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e)
      return {class:e.className,width:r.width,height:r.height,font:s.fontSize,display:s.display,columns:s.gridTemplateColumns}
    }))
    const wide=await geometry()
    await win.locator('.lgd-page').screenshot({path:stage+'/global-wide'+suffix+'.png'})
    await win.locator('.lgd-page').evaluate(e=>{e.style.width='390px';e.scrollTop=0})
    const narrow=await geometry()
    assert.ok(await win.locator('.lgd-page').evaluate(e=>e.scrollWidth<=e.clientWidth+1))
    await win.locator('.lgd-page').screenshot({path:stage+'/global-narrow'+suffix+'.png'})
    await win.evaluate(()=>document.body.setAttribute('data-ds-dark-theme','dark'))
    await win.locator('.lgd-page').evaluate(e=>{e.style.width='';e.scrollTop=0})
    await win.locator('.lgd-page').screenshot({path:stage+'/global-dark'+suffix+'.png'})
    await win.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'))

    await win.evaluate(()=>{dashboardRequests.length=0})
    await win.locator('.lgg-book-link').filter({hasText:'潮汐来信'}).click()
    await win.locator('.lgd-chapter-head').first().waitFor()
    assert.equal(await win.getByLabel('当前作品').inputValue(),stage+'/Books/潮汐来信')
    assert.equal(await win.getByRole('button',{name:'本书新对话',exact:true}).isEnabled(),true)
    const bookRequests=await win.evaluate(()=>dashboardRequests.map(r=>r.action))
    if(!baseline)assert.deepEqual(bookRequests,['read'],'book navigation reuses the parent shelf')
    await win.locator('.lgd-browser-controls input').fill('第三章')
    assert.equal(await win.locator('.lgd-chapter-head').count(),1)
    await win.locator('.lgd-browser-controls input').fill('')
    await win.locator('.lgd-chapter-head').first().click()
    await win.getByRole('button',{name:'审阅此版本',exact:true}).waitFor()
    await win.locator('.lgd-page').screenshot({path:stage+'/book'+suffix+'.png'})
    await win.getByRole('button',{name:baseline?'‹ 全局 Dashboard':'Global Dashboard',exact:true}).click()
    await global().waitFor();await win.locator('.lgg-book-link').first().waitFor()
    await win.evaluate(()=>{dashboardRequests.length=0})
    await win.getByRole('button',{name:'刷新',exact:true}).click()
    await win.waitForFunction(()=>dashboardRequests.filter(r=>r.action==='read').length===2&&
      [...document.querySelectorAll('.lgg-page header button')].some(b=>b.textContent==='刷新'&&!b.disabled))
    const refreshRequests=await win.evaluate(()=>dashboardRequests.map(r=>r.action))
    assert.equal(refreshRequests.filter(a=>a==='shelf').length,1)
    assert.equal(refreshRequests.filter(a=>a==='read').length,2)

    if(!baseline){
      await win.getByRole('button',{name:'设置目录',exact:true}).click()
      assert.equal(await win.getByLabel('Books 创作目录',{exact:true}).inputValue(),stage+'/Books')
      assert.equal(await win.getByLabel('Library 参考库目录',{exact:true}).inputValue(),stage+'/Library')
      await win.getByRole('button',{name:'保存并加载',exact:true}).click()
      await global().waitFor();await win.locator('.lgg-book-link').first().waitFor()
      await win.getByRole('button',{name:'管理作品',exact:true}).click()
      await win.getByLabel('新作品名称',{exact:true}).fill('合成预览作品')
      await win.getByRole('button',{name:'预览创建',exact:true}).click()
      await win.getByRole('button',{name:'确认创建并添加作品',exact:true}).waitFor()
      assert.equal(existsSync(stage+'/Books/合成预览作品'),false,'preview must not write a book')
      await win.getByRole('button',{name:'返回修改',exact:true}).click()
      await win.getByRole('button',{name:'Global Dashboard',exact:true}).click()
      await global().waitFor();await win.getByRole('button',{name:'刷新',exact:true}).waitFor()
      await win.evaluate(()=>{
        const original=window.fetch;let fail=true
        window.fetch=async(...args)=>{
          if(fail&&String(args[0]).includes('api/lg/books')&&JSON.parse(args[1]?.body??'{}').action==='shelf'){
            fail=false;return Response.json({ok:false,error:'Synthetic root failure'},{status:503})
          }
          return original(...args)
        }
      })
      await win.getByRole('button',{name:'刷新',exact:true}).click()
      await win.getByText('Synthetic root failure',{exact:true}).waitFor()
      await win.getByRole('button',{name:'重试',exact:true}).click()
      await global().waitFor();await win.locator('.lgg-book-link').first().waitFor()
      assert.equal(await win.getByText('Synthetic root failure',{exact:true}).count(),0)
      // First request fails, retry succeeds with unconfigured folders: setup must recover.
      await win.addInitScript(()=>{
        const original=window.fetch;let failures=0
        window.dashboardSetupProbe=true
        window.fetch=async(...args)=>{
          if(window.dashboardSetupProbe&&String(args[0]).includes('api/lg/books')&&JSON.parse(args[1]?.body??'{}').action==='shelf'){
            if(failures++===0)return Response.json({ok:false,error:'Synthetic startup failure'},{status:503})
            return Response.json({ok:true,value:{booksPath:'',libraryPath:'',books:[],unavailable:[],indexes:[]}})
          }
          return original(...args)
        }
      })
      await win.reload()
      const dialog=win.getByRole('dialog',{name:'LiteraryGiant',exact:true})
      await dialog.getByText('Synthetic startup failure',{exact:false}).waitFor()
      await dialog.getByRole('button',{name:'↻',exact:true}).click()
      await dialog.getByRole('button',{name:'选择 Books 目录',exact:true}).waitFor()
      await dialog.getByRole('button',{name:'选择 Library 目录',exact:true}).waitFor()
      assert.equal(await dialog.getByText('Synthetic startup failure',{exact:false}).count(),0)
    }
    return {initialShelfRequests:initial,bookRequests,refreshRequests,wide,narrow}
  }catch(error){if(win)await win.screenshot({path:stage+'/desktop-failure'+suffix+'.png'}).catch(()=>{});throw error}
  finally{await app.close()}
}
const before=await inspect(true),after=await inspect(false)
assert.equal(after.initialShelfRequests,before.initialShelfRequests-1)
assert.deepEqual(after.wide,before.wide,'wide layout must remain unchanged')
assert.deepEqual(after.narrow,before.narrow,'narrow layout must remain unchanged')
writeFileSync(stage+'/desktop-results.json',JSON.stringify({before,after,paidCalls:0},null,2))
console.log('PASS: real App navigation, refresh counts, folder save, create preview, root/startup recovery, date semantics and unchanged wide/narrow geometry')
