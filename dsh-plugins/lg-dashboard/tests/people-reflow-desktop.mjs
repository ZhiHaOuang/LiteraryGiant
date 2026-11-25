import assert from 'node:assert/strict'

// The fourth card crosses from the right of row one to the left of row two.
export async function checkPeopleReflow(win,collection){
 const browser=collection.locator('..'),tab=collection.getByRole('tab',{name:'Card View'})
 const before=await browser.evaluate(el=>el.style.width)
 const settle=()=>browser.evaluate(async el=>{
  await new Promise(resolve=>setTimeout(resolve,420))
  const deadline=performance.now()+8000
  while(el.getAttribute('aria-busy')==='true'){
   if(performance.now()>deadline)throw Error('Character page did not settle')
   await new Promise(requestAnimationFrame)
  }
 })
 async function sample(width,reverse=false,index=3){
  return browser.evaluate(async(el,{width,reverse,index})=>{
   const grid=el.querySelector('.lgd-people-grid'),card=grid.children[index]
   const bounds=()=>{const r=card.getBoundingClientRect(),g=grid.getBoundingClientRect()
    return {x:r.left-g.left,y:r.top-g.top,width:r.width,gridHeight:g.height}}
   const frames=[bounds()],original=el.style.width
   el.style.width=width+'px'
   let turn=0
   const start=performance.now()
   do{
    await new Promise(requestAnimationFrame)
    frames.push(bounds())
    if(reverse&&!turn&&performance.now()-start>=70){
     turn=frames.length-1
     el.style.width=original
    }
   }while(performance.now()-start<410)
   return {frames,turn,same:card===grid.children[index]}
  },{width,reverse,index})
 }
 try{
  await win.emulateMedia({reducedMotion:'no-preference'})
  await tab.click()
  await browser.evaluate(el=>el.style.width='810px')
  await settle()
  const same=await sample(915)
  const crossed=await sample(650)
  const heights=crossed.frames.map(f=>f.gridHeight)
  assert.ok(Math.max(...heights)<=Math.max(heights[0],heights.at(-1))+4,'shrinking the page should not flash a third row')
  const widths=same.frames.map(f=>f.width),start=widths[0],end=widths.at(-1)
  assert.ok(same.same&&end-start>2,'same-column resizing retains the existing card')
  assert.ok(widths.every(w=>Math.abs(w-start)<1||Math.abs(w-end)<1),'width follows the pointer without trailing intermediate animation')
  for(const [run,key] of [[crossed,'x'],[crossed,'y'],[crossed,'width']]){
   const values=run.frames.map(f=>f[key]),low=Math.min(values[0],values.at(-1)),high=Math.max(values[0],values.at(-1))
   assert.ok(run.same&&high-low>2,key+' should move on the existing button')
   assert.ok(new Set(values.filter(n=>n>low+1&&n<high-1)).size>=2,key+' should pass through intermediate positions')
  }
  const reversed=await sample(915,true)
  assert.ok(reversed.turn>0&&reversed.same)
  const x=reversed.frames.map(f=>f.x),at=x[reversed.turn]
  assert.ok(at>x[0]+20&&Math.abs(x.at(-1)-x[0])<1,'reverse should finish back on the original track')
  assert.ok(Math.abs(x[reversed.turn+1]-at)<Math.abs(at-x[0]),'reverse should continue from the current position')
  await collection.getByRole('tab',{name:'List View'}).click()
  await settle()
  const list=await sample(915,false,4)
  const listY=list.frames.map(f=>f.y)
  assert.ok(list.same&&listY.some(y=>y>listY.at(-1)+1&&y<listY[0]-1),'list thumbnails should move between rows')
  await tab.click()
  await settle()
  await win.emulateMedia({reducedMotion:'reduce'})
  await settle()
  const instant=await sample(650)
  const ys=instant.frames.map(f=>Math.round(f.y))
  assert.ok(new Set(ys).size===2,'reduced motion should go directly to the new row')
 }finally{
  await win.emulateMedia({reducedMotion:null})
  await browser.evaluate((el,width)=>el.style.width=width,before)
  await settle()
 }
}
