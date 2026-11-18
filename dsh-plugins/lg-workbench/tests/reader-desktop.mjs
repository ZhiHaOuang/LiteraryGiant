import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
const {_electron:electron}=await import(process.env.LG_PLAYWRIGHT_MODULE)
const stage=process.env.LG_READER_TEST_ROOT
assert.ok(stage?.includes('LitIsLand/reader-trial-'),'Use the isolated reader-trial profile')
const app=await electron.launch({executablePath:'/Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant',args:['--user-data-dir='+stage+'/userData'],env:{...process.env,DSH_HOME:process.env.LG_READER_TEST_HOME??stage+'/home'},timeout:20000})
let page
try{
  page=await app.firstWindow();page.setDefaultTimeout(15000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1100))
  await page.getByRole('button',{name:'文学编辑台',exact:true}).click()
  const firstBook=await page.getByLabel('作品',{exact:true}).locator('option').nth(1).getAttribute('value')
  await page.getByLabel('作品',{exact:true}).selectOption(firstBook)
  const original=await page.getByLabel('待编辑文本',{exact:true}).inputValue()
  await page.getByRole('button',{name:'阅读对照',exact:true}).click()
  const choices=['鲸歌 · 沉浸阅读','Reading Workbench · 分页','Annotator · 批注']
  for(let i=0;i<choices.length;i++){
    await page.getByRole('button',{name:choices[i],exact:true}).click()
    const frame=page.frameLocator('.lgr-trial iframe')
    await frame.getByText(original.trim(),{exact:false}).first().waitFor()
    assert.ok((await frame.locator('body').textContent()).includes(original.trim()))
    await page.getByRole('button',{name:'展开阅读',exact:true}).click()
    await page.screenshot({path:stage+'/reader-'+i+'.png'})
    await page.getByRole('button',{name:'收起阅读',exact:true}).click()
    const next=await page.getByLabel('阅读章节',{exact:true}).locator('option').nth(1).getAttribute('value')
    await page.getByRole('button',{name:'下一章',exact:true}).click()
    await page.getByLabel('阅读章节',{exact:true}).waitFor()
    assert.equal(await page.getByLabel('阅读章节',{exact:true}).inputValue(),next)
    assert.equal(await page.getByRole('button',{name:choices[i],exact:true}).getAttribute('aria-pressed'),'true')
    await page.getByRole('button',{name:'上一章',exact:true}).click()
    await page.frameLocator('.lgr-trial iframe').getByText(original.trim(),{exact:false}).first().waitFor()
  }
  await page.getByRole('button',{name:'章节正文',exact:true}).click()
  assert.equal(await page.getByLabel('待编辑文本',{exact:true}).inputValue(),original)
  await page.getByLabel('待编辑文本',{exact:true}).fill(original+'未保存测试')
  assert.equal(await page.getByRole('button',{name:'阅读对照',exact:true}).isDisabled(),true)
  await page.getByRole('button',{name:'放弃未保存编辑',exact:true}).click()
  await page.getByRole('button',{name:'阅读对照',exact:true}).click()
  const versions=await page.getByLabel('阅读版本',{exact:true}).locator('option').evaluateAll(es=>es.map(e=>({id:e.value,label:e.textContent})))
  const candidate=versions.find(v=>v.label.includes('candidate'))
  assert.ok(candidate,'fixture has a candidate')
  await page.getByLabel('阅读版本',{exact:true}).selectOption(candidate.id)
  await page.getByLabel('阅读版本',{exact:true}).waitFor()
  assert.equal(await page.getByLabel('阅读版本',{exact:true}).inputValue(),candidate.id)
  assert.equal(errors.length,0,JSON.stringify(errors))
  writeFileSync(stage+'/reader-result.json',JSON.stringify({choices,chapterSwitch:true,dirtyEditorProtected:true,candidateVersion:true,pageErrors:errors},null,2))
  console.log('PASS: three actual readers, chapter navigation, candidate selection and unsaved editor guard')
}catch(error){if(page)await page.screenshot({path:stage+'/reader-failure.png'}).catch(()=>{});throw error}
finally{await app.close()}
