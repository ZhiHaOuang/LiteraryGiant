/** Negative evidence must not pass a token or permission gate. */
import path from 'node:path'
import { readAcceptance, startupAssessment, startupReadiness, readControlPassed, rejectedWithoutEffects } from '../bench/gates/integrity.mjs'
import { verifyEmittedReads } from '../bench/gates/metrics.mjs'
import { NATIVE_RESIDENT_FILE_TOOLS } from '../lib/capabilities/registry.js'
import { publicToolName } from '../lib/policy.js'
import { assert, report, test } from './lib/harness.mjs'
const core = [...NATIVE_RESIDENT_FILE_TOOLS, 'discover_tools'].map(raw => ({name:publicToolName(raw)}))
await test('startup needs the exact default Native surface before any token score can pass', () => {
  for(const platform of ['linux','darwin']) {
    assert.equal(startupReadiness(core,platform).ready,true)
    for(const absent of core) {
      const result=startupReadiness(core.filter(tool=>tool!==absent),platform)
      assert.equal(result.ready,false)
      assert.deepEqual(result.missing,[absent.name])
      assert.match(result.reason,/missing required/)
    }
    assert.equal(startupReadiness([],platform).ready,false)
    assert.equal(startupReadiness([...core,core[0]],platform).ready,false)
    assert.equal(startupReadiness([...core,{name:publicToolName('stat')}],platform).ready,false)
  }
  const bash={name:publicToolName('bash'),parameters:{required:['description'],properties:{run_in_background:{type:'boolean'}}}}
  assert.equal(startupReadiness([...core,bash],'win32').ready,true)
  assert.equal(startupReadiness(core,'win32').ready,false)
  assert.equal(startupReadiness([...core,{name:bash.name,parameters:{}}],'win32').ready,false)
})
await test('BM-01 gates the approved OPS baseline without hiding the official comparison', () => {
  assert.equal(readAcceptance({baseline:.4,official:-.2},1),'passed')
  assert.equal(readAcceptance({baseline:.39999,official:.9},1),'failed')
  assert.equal(readAcceptance({baseline:.6,official:.6},2),'failed')
  assert.equal(readAcceptance({official:.9},1),'failed')
})
await test('the file/discovery budget still requires Bash and retains full startup cost', () => {
  const bash={name:publicToolName('bash'),description:'shell contract '.repeat(600),parameters:{required:['description'],properties:{run_in_background:{type:'boolean'}}}}
  const tools=[bash,...core], result=startupAssessment(tools,'win32')
  assert.equal(result.status,'passed')
  assert.ok(result.gatedMeasurement.tokens<=400)
  assert.ok(result.measurement.tokens>400)
  assert.deepEqual(result.names,tools.map(tool=>tool.name))
  assert.deepEqual(result.gatedNames,core.map(tool=>tool.name))
  assert.equal(startupAssessment(core,'win32').status,'blocked')
  assert.equal(startupAssessment([...tools,core[0]],'win32').status,'blocked')
  assert.equal(startupAssessment([...tools,{name:publicToolName('stat')}],'win32').status,'blocked')
  const oversized=tools.map(tool=>tool===core[0]?{...tool,description:'file contract '.repeat(600)}:tool)
  assert.equal(startupAssessment(oversized,'win32').status,'failed')
})
await test('authority gates require a successful allowed control and the exact effect-free denial codes', () => {
  const file=path.resolve('ordinary.txt'),item={status:'completed',path:file,complete:true,truncated:false,failed:0,items:[{path:file,line:1,text:'outside ordinary data'}]}
  const value={status:'completed',failed:0,pending:0,truncated:false,items:[item]}
  assert.equal(readControlPassed(value,file,'outside ordinary data'),true)
  for(const changed of [{...value,status:'rejected'},{...value,items:[]},{...value,items:[{...item,items:[{path:file,line:1,text:'wrong'}]}]}]) assert.equal(readControlPassed(changed,file,'outside ordinary data'),false)
  for(const code of ['CREDENTIAL_DENIED','POLICY_DENIED']) {
    assert.equal(rejectedWithoutEffects({status:'rejected',error:{code,effectState:'none'}},code),true)
    assert.equal(rejectedWithoutEffects({status:'rejected',error:{code:'INVALID_ARGUMENT',effectState:'none'}},code),false)
    assert.equal(rejectedWithoutEffects({status:'rejected',error:{code,effectState:'unknown'}},code),false)
  }
})
await test('emitted-line verification decodes source instead of accepting colliding escape text', () => {
  const file=path.resolve('escapes.txt'),files=[{path:file,expected:[{line:1,text:'\t'},{line:2,text:'\\t'},{line:3,text:'a"b\\c'}]}]
  const header='=== FILE: '+JSON.stringify(file)+' (Lines 1-3 of 3) ===\n'
  const valid=header+'1|\\t\n2|\\\\t\n3|a"b\\\\c'
  verifyEmittedReads({committed:[{text:valid}]},files,'candidate')
  assert.throws(()=>verifyEmittedReads({committed:[{text:valid.replace('2|\\\\t','2|\\t')}]},files,'candidate'),/all emitted/)
})
report('bench-integrity')
