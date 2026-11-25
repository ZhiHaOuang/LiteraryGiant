import assert from 'node:assert/strict'
import {resolve} from 'node:path'
import {checkNavigation, checkStickers, saveNewNote, selectPassage} from './reading-interactions.mjs'
const {_electron} = await import(process.env.LG_PLAYWRIGHT_MODULE)
const root = process.env.LG_READING_REVIEW_ROOT
assert.ok(root && resolve(root).includes('/LitIsLand/lg-reading-review-'), 'Requires an isolated home and synthetic book')
const app = await _electron.launch({executablePath:'/Applications/LiteraryGiant.app/Contents/MacOS/LiteraryGiant',
  args:['--user-data-dir='+root+'/userData'],env:{...process.env,DSH_HOME:root+'/home'}})
const page = await app.firstWindow()
page.setDefaultTimeout(12000)
const button = name => page.getByRole('button',{name,exact:true})
const ui = page.locator('.lgrv:visible')
const group = name => ui.getByRole('group',{name,exact:true})
async function setting(name,label) {
  const choices = group(name)
  await choices.getByRole('button',{name:label,exact:true}).click()
  await choices.getByRole('button',{name:label,exact:true,pressed:true}).waitFor()
}
async function checkLayout(width) {
  // A split pane can be far narrower than its desktop window.
  await ui.evaluate((e,width) => { e.style.maxWidth = width + 'px' },width)
  const bounds = await ui.evaluate(e => {
    const rect = node => {
      const {top,bottom,left,right} = node.getBoundingClientRect()
      return {top,bottom,left,right}
    }
    return {
      paneWidth:e.clientWidth, overflows:[e,...e.querySelectorAll('.lgrv-setting, .lgrv-options, .lgrv-panel')]
        .some(node=>node.scrollWidth > node.clientWidth + 1),
      controls:[...e.querySelectorAll('.lgrv-typography > *')].map(rect),
      panels:[...e.querySelectorAll('.lgrv-grid > .lgrv-panel')].map(rect),
    }
  })
  assert.equal(bounds.paneWidth,width)
  assert.equal(bounds.overflows,false)
  const [font,size,line,gap] = bounds.controls
  const [contents,prose,review] = bounds.panels
  assert.ok(font.right <= size.left && font.top === size.top)
  if (width > 930) assert.ok(size.right <= line.left && line.right <= gap.left && font.top === gap.top)
  else assert.ok(font.bottom <= line.top && line.top === gap.top)
  if (width > 760) assert.ok(contents.right <= prose.left && prose.right <= review.left && contents.top === review.top)
  else if (width >= 590) assert.ok(contents.bottom <= prose.top && prose.right <= review.left && prose.top === review.top)
  else assert.ok(contents.bottom <= prose.top && prose.bottom <= review.top)
  await ui.evaluate(e => e.style.removeProperty('max-width'))
}
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
try {
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1500,940))
  await page.locator('body').waitFor()
  await page.getByRole('button',{name:/^(Continue|继续|Reading Review|Open sidebar)$/}).first().waitFor()
  const intro=page.getByRole('button',{name:/^(Continue|继续)$/})
  if(await intro.isVisible()) await intro.click()
  const dialog=page.getByRole('dialog')
  if(await dialog.getByRole('button',{name:/^(Close|关闭)$/}).first().isVisible()) await dialog.getByRole('button',{name:/^(Close|关闭)$/}).first().click()
  if(!await button('Reading Review').first().isVisible() && await button('Open sidebar').isVisible()) await button('Open sidebar').click()
  await button('Reading Review').first().click()
  await ui.locator('.lgrv-prose p').first().waitFor()
  await ui.getByRole('region',{name:'Table of Contents',exact:true}).getByRole('heading',{name:/^Table of Contents/}).waitFor()
  const title = page.locator('[data-lg-page-title]:visible')
  assert.equal(await title.textContent(),'Reading Review')
  const book = group('Book').getByRole('button',{name:/潮汐来信/,pressed:true})
  await book.waitFor()
  const originalName = await book.textContent()
  async function renameFixture(name) {
    await page.evaluate(async ({root,name}) => {
      const send = async input => {
        const response = await fetch('api/lg/books',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})
        const result = await response.json()
        if (!result.ok) throw Error(result.error)
        return result.value
      }
      const path = JSON.parse(localStorage.getItem('lg.reading.book'))
      if (!path.startsWith(root + '/')) throw Error('Only the isolated book may be renamed')
      const current = (await send({action:'list'})).find(item=>item.path===path)
      await send({action:'rename',path,projectId:current.id,expectedName:current.name,name})
      window.dispatchEvent(new Event('lg-books-changed'))
    },{root:resolve(root),name})
    await group('Book').getByRole('button',{name,exact:true,pressed:true}).waitFor()
  }
  try {
    await renameFixture('灯塔来信')
    assert.equal(await title.textContent(),'Reading Review')
  } finally { await renameFixture(originalName) }
  const settings = ui.getByRole('region',{name:'Reading settings'})
  assert.equal(await settings.getByRole('group').count(),6)
  assert.equal(await settings.getByRole('button',{pressed:true}).count(),6)
  await checkLayout(1000)
  await checkLayout(680)
  await checkLayout(360)
  await checkNavigation(page,ui)
  await setting('Line height','2.2×')
  await setting('Paragraph spacing','Relaxed')
  await setting('Font size','22 px')
  await setting('Font','Kai')
  const metrics=await ui.locator('.lgrv-prose p').first().evaluate(e=>[getComputedStyle(e).fontSize,parseFloat(getComputedStyle(e).lineHeight),parseFloat(getComputedStyle(e).marginBottom)])
  assert.equal(metrics[0],'22px');assert.ok(metrics[1]>48 && metrics[2]>26)
  assert.match(await ui.locator('.lgrv-prose').evaluate(e=>getComputedStyle(e).fontFamily),/Kaiti/i)
  assert.equal(await group('Font').getByRole('button',{name:'Kai'}).evaluate(e=>getComputedStyle(e).borderRadius),'3px')
  assert.equal(await ui.locator('.lgrv-panel').first().evaluate(e=>getComputedStyle(e).borderRadius),'6px')
  assert.equal(await button('Edit text').evaluate(e=>getComputedStyle(e).borderRadius),'4px')
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('lg.reading.type'))),{font:'kai',size:22,line:2.2,gap:1.2})
  const original = await ui.locator('.lgrv-prose p').allTextContents()
  await selectPassage(ui,0,2,1,3)
  await button('Annotate selection').click()
  const note=ui.getByRole('textbox',{name:'Note'})
  const message='两段之间的停顿很好。可以保留钟声，再交代她为何推窗。'
  await note.fill(message)
  assert.ok(await book.isDisabled())
  assert.ok(await group('Version').getByRole('button').first().isDisabled())
  assert.ok(await group('Font').getByRole('button').first().isEnabled())
  assert.equal(await button('Next ›').isDisabled(),true)
  const card=await saveNewNote(page,ui)
  assert.match(await card.locator('blockquote').textContent(),/\n\n/)
  await checkStickers(page,ui,card,original)
  await checkLayout(360)
  await page.emulateMedia({reducedMotion:'reduce'})
  assert.equal(await ui.locator('mark').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s')
  await page.emulateMedia({reducedMotion:'no-preference'})
  await card.getByRole('button',{name:'Edit'}).click()
  await note.fill(message+'（已复看）')
  await button('Save note').click()
  await card.getByRole('button',{name:'Resolve'}).click()
  await card.getByText('Resolved',{exact:true}).waitFor()
  await setting('Version','v2 · Candidate')
  assert.equal(await title.textContent(),'Reading Review')
  await ui.getByText('Select a passage to annotate it, or add a note for the whole chapter.').waitFor()
  assert.equal(await ui.locator('mark').count(),0)
  await setting('Version','v1 · Current manuscript')
  await card.waitFor()
  await button('Next ›').click()
  await ui.getByRole('heading',{name:'第二章 潮汐来信'}).waitFor()
  await button('‹ Previous').click()
  await card.getByRole('button',{name:'Locate',exact:true}).click()
  assert.ok(await ui.locator('mark.active').count()>=2)
  await page.screenshot({path:root+'/desktop-wide.png',animations:'disabled'})
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(660,840))
  await ui.getByRole('button',{name:'Expand',exact:true}).click()
  await ui.getByLabel('Filter chapters').fill('第二章')
  assert.equal(await ui.locator('.lgrv-list button').count(),1)
  assert.ok(await ui.evaluate(e=>e.scrollWidth<=e.clientWidth+1))
  await page.screenshot({path:root+'/desktop-narrow.png',animations:'disabled'})
  await setting('Version','v2 · Candidate')
  await ui.getByText('候选文本不能计入正式正文',{exact:true}).waitFor()
  await button('Edit text').click()
  const middle=ui.getByLabel('Edit manuscript',{exact:true})
  await middle.fill('只保存为Candidate的合成修订。')
  await ui.getByLabel('Reason for this edit').fill('验证中栏改稿与原文版本隔离')
  await button('Preview candidate').click()
  assert.equal(await middle.getAttribute('readonly'),'')
  await button('Confirm save').click()
  await ui.locator('.lgrv-prose').getByText('只保存为Candidate的合成修订。',{exact:true}).waitFor()
  await setting('Version','v1 · Current manuscript')
  await card.waitFor()
  assert.match(await ui.locator('.lgrv-prose').textContent(),/守灯人合上信/)
  await setting('Version','v2 · Candidate')
  await ui.getByText('候选文本不能计入正式正文',{exact:true}).waitFor()
  await button('Edit text').click()
  await button('Back to reading').click()
  await ui.getByText('候选文本不能计入正式正文',{exact:true}).waitFor()
  await setting('Version','v1 · Current manuscript')
  await card.waitFor()
  const lightPaper = await ui.locator('.lgrv-paper').evaluate(e=>getComputedStyle(e).backgroundColor)
  await app.evaluate(({nativeTheme})=>{nativeTheme.themeSource='dark'})
  await page.emulateMedia({colorScheme:'dark'})
  await page.waitForFunction(light => getComputedStyle(document.querySelector('.lgrv-paper')).backgroundColor !== light,lightPaper)
  const colors = await group('Font').getByRole('button').evaluateAll(buttons=>buttons.map(e=>getComputedStyle(e).backgroundColor))
  assert.notEqual(colors[0],colors[2])
  await page.screenshot({path:root+'/desktop-dark.png'})
  assert.deepEqual(errors,[])
  console.log('PASS desktop • stable navigation, response races and retry, paired stickers, overlapping selections, keyboard links, three layouts, dark theme and candidate editing')
} catch(error) {
  await page.screenshot({path:root+'/desktop-failure.png'}).catch(()=>{})
  console.error((await page.locator('body').innerText()).slice(0,1300))
  throw error
} finally {await app.close()}
