import assert from 'node:assert/strict'

export async function checkNavigation(page,ui) {
  const choose = (group,name) => ui.getByRole('group',{name:group,exact:true}).getByRole('button',{name,exact:true})
  const prose = ui.locator('.lgrv-prose')
  const first = await ui.locator('.lgrv-list button[aria-current]').textContent()
  const second = await ui.locator('.lgrv-list button').nth(1).textContent()
  const original = await prose.innerText()
  // Hold only one response so another chapter request can finish out of order.
  await page.evaluate(()=>{
    const trace = window.readingProbe = {
      fetch:window.fetch, requests:[], blanks:0, origin:performance.timeOrigin,
      paper:document.querySelector('.lgrv-paper'), root:document.querySelector('.lgrv'),
    }
    trace.observer = new MutationObserver(()=>{
      if (!trace.root.querySelector('.lgrv-paper') || !trace.root.querySelector('.lgrv-notes')) trace.blanks++
    })
    trace.observer.observe(trace.root,{childList:true,subtree:true})
    window.fetch = async (url,init) => {
      const input = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (input.action) trace.requests.push(input.action)
      if (trace.holdNotes && String(url).endsWith('reading-notes') && input.action === 'list') {
        trace.holdNotes = false
        await new Promise(resolve=>{trace.release=resolve})
      }
      if (trace.failNext && input.action === 'manuscript') {
        trace.failNext = false
        return Response.json({ok:false,error:'Synthetic read failure'})
      }
      if (trace.failNotes && String(url).endsWith('reading-notes') && input.action==='list') {
        trace.failNotes=false
        return Response.json({ok:false,error:'Synthetic notes failure'})
      }
      return trace.fetch.call(window,url,init)
    }
  })
  try {
    await choose('Font size','20 px').click()
    await ui.locator('.lgrv-list button[aria-current]').click()
    assert.deepEqual(await page.evaluate(()=>readingProbe.requests),[])
    assert.ok(await page.evaluate(()=>readingProbe.paper.isConnected))
    await page.evaluate(()=>{readingProbe.holdNotes=true})
    await choose('Version','v2 · Candidate').click()
    await page.waitForFunction(()=>!!window.readingProbe.release)
    assert.equal(await prose.innerText(),original)
    assert.ok(await page.evaluate(()=>readingProbe.paper.isConnected))
    assert.ok(await ui.getByRole('button',{name:'+ Add note'}).isDisabled())
    await ui.getByRole('button',{name:second,exact:true}).click()
    await ui.getByRole('heading',{name:second,exact:true}).waitFor()
    await page.evaluate(()=>readingProbe.release())
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await ui.getByRole('heading',{name:second,exact:true}).waitFor()
    await ui.getByRole('button',{name:first,exact:true}).click()
    await ui.getByRole('heading',{name:first,exact:true}).waitFor()
    await page.evaluate(()=>{readingProbe.failNext=true})
    await choose('Version','v2 · Candidate').click()
    await ui.getByRole('alert').filter({hasText:'Synthetic read failure'}).waitFor()
    assert.equal(await prose.innerText(),original)
    await page.evaluate(()=>{readingProbe.failNotes=true})
    await ui.getByRole('button',{name:'Reload',exact:true}).click()
    await prose.getByText('候选文本不能计入正式正文',{exact:true}).waitFor()
    await ui.getByRole('alert').filter({hasText:'Synthetic notes failure'}).waitFor()
    await ui.getByRole('button',{name:'Reload notes',exact:true}).click()
    await ui.getByText('Select a passage to annotate it, or add a note for the whole chapter.',{exact:true}).waitFor()
    await choose('Version','v1 · Current manuscript').click()
    await ui.getByRole('group',{name:'Version',exact:true}).getByRole('button',{name:'v1 · Current manuscript',pressed:true}).waitFor()
    assert.equal(await prose.innerText(),original)
    assert.ok(await page.evaluate(()=>readingProbe.blanks===0 && readingProbe.origin===performance.timeOrigin))
  } finally {
    await page.evaluate(()=>{
      const trace=window.readingProbe
      trace.release?.(); trace.observer.disconnect(); window.fetch=trace.fetch; delete window.readingProbe
    })
  }
}

export async function selectPassage(ui,startRow,startOffset,endRow,endOffset) {
  await ui.locator('.lgrv-prose').evaluate((prose,[startRow,startOffset,endRow,endOffset])=>{
    const ps=prose.querySelectorAll('p'), range=document.createRange()
    function point(p,offset) {
      const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT)
      for(let node=walker.nextNode();node;node=walker.nextNode()) {
        if(offset<=node.length)return [node,offset]
        offset-=node.length
      }
      throw Error('合成选区超出正文')
    }
    range.setStart(...point(ps[startRow],startOffset));range.setEnd(...point(ps[endRow],endOffset))
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range)
  },[startRow,startOffset,endRow,endOffset])
}

export async function saveNewNote(page,ui) {
  const created=page.waitForRequest(request=>request.url().endsWith('/api/lg/reading-notes') && request.postDataJSON()?.action==='create')
  await ui.getByRole('button',{name:'Save note',exact:true}).click()
  const card=ui.locator('[data-note="'+(await created).postDataJSON().id+'"]')
  await card.waitFor()
  return card
}

export async function checkStickers(page,ui,first,original) {
  const firstNumber=await first.locator('.lgrv-sticker').getAttribute('data-note-number')
  const inline=n=>ui.getByRole('button',{name:'Open note '+n,exact:true})
  assert.equal(await inline(firstNumber).count(),1)
  assert.equal(await inline(firstNumber).getAttribute('data-sticker'),await first.locator('.lgrv-sticker').getAttribute('data-sticker'))
  assert.ok(await ui.locator('.lgrv-prose mark').count()>=2)
  const note=ui.getByRole('textbox',{name:'Note',exact:true})
  await selectPassage(ui,0,4,0,9)
  await ui.getByRole('button',{name:'Annotate selection'}).click()
  assert.equal(await ui.locator('.lgrv-draft blockquote').textContent(),original[0].slice(4,9))
  await note.fill('这处动作可以再具体一点。')
  const overlapping=await saveNewNote(page,ui)
  const next=await overlapping.locator('.lgrv-sticker').getAttribute('data-note-number')
  assert.notEqual(next,firstNumber)
  assert.notEqual(await inline(next).getAttribute('data-sticker'),await inline(firstNumber).getAttribute('data-sticker'))
  assert.equal(await inline(next).getAttribute('data-sticker'),await overlapping.locator('.lgrv-sticker').getAttribute('data-sticker'))
  assert.ok(await ui.locator('mark[data-note-ids*=" "]').count()>0)
  assert.deepEqual(await ui.locator('.lgrv-prose p').allTextContents(),original)
  await selectPassage(ui,0,0,0,original[0].length)
  assert.equal(await page.evaluate(()=>getSelection().toString()),original[0])
  await page.evaluate(()=>getSelection()?.removeAllRanges())
  await page.getByRole('button',{name:'Hide review',exact:true}).click()
  await inline(firstNumber).press('Enter')
  await page.waitForFunction(id=>document.activeElement.matches('.lgrv-card.selected') && document.activeElement.dataset.note===id,await first.getAttribute('data-note'))
  await overlapping.getByRole('button',{name:'Locate note '+next,exact:true}).click()
  assert.ok(await inline(next).evaluate(e=>e===document.activeElement))
  await inline(next).press('Space')
  await page.waitForFunction(id=>document.activeElement.matches('.lgrv-card.selected') && document.activeElement.dataset.note===id,await overlapping.getAttribute('data-note'))
  await page.evaluate(()=>getSelection()?.removeAllRanges())
  await ui.getByRole('button',{name:'+ Add note'}).click()
  await ui.locator('.lgrv-draft strong').filter({hasText:'Chapter note'}).waitFor()
  await note.fill('这一章的海港氛围已经立住了。')
  const chapter=await saveNewNote(page,ui)
  const chapterNumber=await chapter.locator('.lgrv-sticker').getAttribute('data-note-number')
  assert.ok(await inline(chapterNumber).evaluate(e=>!!e.closest('.lgrv-chapter-title')))
  assert.deepEqual(await ui.locator('.lgrv-prose p').allTextContents(),original)
}
