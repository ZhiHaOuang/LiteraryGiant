import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createCardSpring} from '../src/story-card-motion.js'

function fixture(){
 const pending=new Map(),values={};let serial=0,time=16,reduced=false,ids=['people','plot','world']
 const engine=createCardSpring({read:()=>ids,write:(id,value)=>values[id]=value,reduced:()=>reduced,
  requestFrame:callback=>{pending.set(++serial,callback);return serial},cancelFrame:id=>pending.delete(id)})
 const tick=(delta=16.667)=>{time+=delta;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(cb=>cb(time))}
 const settle=()=>{for(let i=0;i<500&&pending.size;i++)tick();assert.equal(pending.size,0)}
 return {engine,values,pending,tick,settle,reduce:()=>reduced=true,ids:value=>ids=value}
}

test('three cards start equal, share one clock, and settle back to equal widths',()=>{
 const f=fixture();f.engine.set();f.settle();assert.deepEqual(Object.values(f.values),[1,1,1])
 f.engine.set('plot');f.engine.set('plot');assert.equal(f.pending.size,1);f.settle()
 assert.equal(f.values.plot,1.22);assert.ok(f.values.people>1&&f.values.people<f.values.plot)
 assert.equal(f.values.people,f.values.world)
 f.engine.set();f.settle();assert.deepEqual(Object.values(f.values),[1,1,1])
})
test('rapid retargeting keeps the current spring position instead of jumping',()=>{
 const f=fixture();f.engine.set('people');f.tick();f.tick();const previous={...f.values}
 f.engine.set('world');assert.deepEqual(f.values,previous);assert.equal(f.pending.size,1)
 f.tick();assert.ok(Math.abs(f.values.people-previous.people)<.06);f.settle();assert.equal(f.values.world,1.22)
})
test('opening a panel resets the remaining pair to equal widths',()=>{
 const f=fixture();f.engine.set('people');f.settle();f.ids(['plot','world']);f.engine.reset()
 assert.equal(f.pending.size,0);assert.equal(f.values.plot,1);assert.equal(f.values.world,1)
 f.engine.set('world');f.settle();assert.equal(f.values.world,1.22)
 f.ids(['people','plot','world']);f.engine.reset();assert.deepEqual(Object.values(f.values),[1,1,1])
})
test('reduced motion immediately settles and cancels a running frame',()=>{
 const f=fixture();f.engine.set('people');f.tick();f.reduce();f.engine.set('world')
 assert.equal(f.pending.size,0);assert.equal(f.values.world,1.22)
})
test('large frame gaps stay finite and destroy cancels all future work',()=>{
 const f=fixture();f.engine.set('plot');f.tick();f.tick(120000)
 assert.ok(Object.values(f.values).every(value=>Number.isFinite(value)&&value>=.05))
 f.engine.destroy();assert.equal(f.pending.size,0);const before={...f.values}
 f.engine.set('people');f.engine.reset();f.tick();assert.deepEqual(f.values,before)
})
test('two instances have independent targets, clocks and disposal',()=>{
 const a=fixture(),b=fixture();a.engine.set('people');b.engine.set('world');a.engine.destroy();b.settle()
 assert.equal(a.pending.size,0);assert.equal(b.values.world,1.22)
})
