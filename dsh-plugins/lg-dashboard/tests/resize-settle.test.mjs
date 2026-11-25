import test from 'node:test'
import assert from 'node:assert/strict'
import {createResizeSettler} from '../src/resize-settle.js'

test('a held resize never publishes, even between slow frames; release publishes only the last size',t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const target=new EventTarget(),values=[],settler=createResizeSettler(target,n=>values.push(n))
 target.dispatchEvent(new Event('pointerdown'))
 for(const width of [400,500,450]){settler.schedule(width);t.mock.timers.tick(500)}
 assert.deepEqual(values,[])
 target.dispatchEvent(new Event('pointerup'));t.mock.timers.tick(150)
 assert.deepEqual(values,[450]);settler.dispose()
})

test('window resize coalesces on quiet time; cancellation, blur and disposal settle or cancel the pending work',t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const target=new EventTarget(),values=[],settler=createResizeSettler(target,n=>values.push(n))
 settler.schedule(400);t.mock.timers.tick(100);settler.schedule(450);t.mock.timers.tick(149)
 assert.deepEqual(values,[]);t.mock.timers.tick(1);assert.deepEqual(values,[450])
 for(const end of ['pointercancel','blur']){
  target.dispatchEvent(new Event('pointerdown'));settler.schedule(end);t.mock.timers.tick(500)
  target.dispatchEvent(new Event(end));t.mock.timers.tick(150)
 }
 assert.deepEqual(values,[450,'pointercancel','blur'])
 settler.schedule(600);settler.dispose();t.mock.timers.tick(1000)
 assert.deepEqual(values,[450,'pointercancel','blur'])
})
