import test from 'node:test'
import assert from 'node:assert/strict'
import {fitBubbleWidths} from '../src/companion-layout.js'
test('short line gets enough width to avoid a lone tail while total width and pointer candidates fit',()=>{
 const widths=fitBubbleWidths([99,121,143],402,[[35,90],[145,255],[310,365]],10,(i,w)=>Math.ceil([9,11,13][i]/Math.max(1,Math.floor((w-14)/11))))
 assert.ok(widths[0]>=113)
 assert.equal(widths.reduce((a,b)=>a+b,0)+20,402)
 let left=0
 widths.forEach((w,i)=>{assert.ok([[35,90],[145,255],[310,365]][i].some(x=>x>=left+4&&x<=left+w-4));left+=w+10})
 assert.ok(widths.every(w=>w>=64))
})
