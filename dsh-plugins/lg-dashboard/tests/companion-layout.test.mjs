import test from 'node:test'
import assert from 'node:assert/strict'
import {fitBubbleWidths,measureBubbleText} from '../src/companion-layout.js'
test('two tiny replies release their reserved space so a long sentence wraps into fewer lines',()=>{
 const width=190,anchors=[[16,48],[80,111],[143,175]]
 const widths=fitBubbleWidths([264,15,15],width,anchors,10)
 assert.ok(widths[0]>=90,'the long sentence can use roughly half the row')
 assert.ok(widths[1]<40,'T.T does not reserve a 64px lane')
 assert.ok(Math.ceil(264/(widths[0]-14))<Math.ceil(264/((width-20)/3-14)))
 assert.ok(Math.abs(widths.reduce((sum,w)=>sum+w,0)+20-width)<.001)
})
test('short line gets enough width to avoid a lone tail while total width and pointer candidates fit',()=>{
 const widths=fitBubbleWidths([99,121,143],402,[[35,90],[145,255],[310,365]],10,(i,w)=>Math.ceil([9,11,13][i]/Math.max(1,Math.floor((w-14)/11))))
 assert.ok(widths[0]>=113)
 assert.equal(widths.reduce((a,b)=>a+b,0)+20,402)
 let left=0
 widths.forEach((w,i)=>{assert.ok([[35,90],[145,255],[310,365]][i].some(x=>x>=left+4&&x<=left+w-4));left+=w+10})
 assert.ok(widths.every(w=>w>=64))
})

test('search work stays bounded on large screens and keeps every avatar pointer inside its lane',()=>{
 for(const width of [240,402,800,2400,7680]){
  const anchors=[[width*.1,width*.22],[width*.42,width*.56],[width*.78,width*.9]]
  let estimates=0
  const widths=fitBubbleWidths([99,660,143],width,anchors,10,(i,w)=>{
   estimates++;return Math.max(1,Math.ceil([99,660,143][i]/Math.max(1,w-14)))
  })
  assert.ok(estimates<=3*192,'the estimate count must not grow with screen resolution')
  assert.ok(widths.every(w=>w>0))
  assert.ok(Math.abs(widths.reduce((a,b)=>a+b,0)+20-width)<.001)
  let left=0
  widths.forEach((w,i)=>{assert.ok(anchors[i].some(x=>x>=left+4&&x<=left+w-4));left+=w+10})
 }
 assert.deepEqual(fitBubbleWidths([],300,[]),[])
})

test('cached glyph widths account for whole CJK characters and punctuation when choosing three lines',()=>{
 const texts=['我偶尔想你多一些，偶尔想你少一些，但不会停止','T.T','T.T']
 const measured=texts.map(text=>measureBubbleText(text,s=>Array.from(s).reduce((sum,c)=>sum+(/[\u3000-\uffff]/u.test(c)?11:5),0)))
 const widths=fitBubbleWidths(measured.map(m=>m.width),190,[[15,46],[78,112],[144,175]],6,(i,w)=>measured[i].linesAt(w))
 assert.equal(measured[0].linesAt(98),4)
 assert.equal(measured[0].linesAt(widths[0]),3)
 assert.ok(measured.slice(1).every((m,i)=>m.linesAt(widths[i+1])===1))
})

test('spaces at a wrap do not add an empty line; explicit breaks and overlong words still wrap',()=>{
 const measure=text=>text.length*5
 assert.equal(measureBubbleText('AB CD',measure).linesAt(24),2)
 assert.equal(measureBubbleText('AB\nCD',measure).linesAt(24),2)
 assert.equal(measureBubbleText('ABCD',measure).linesAt(24),2)
})
