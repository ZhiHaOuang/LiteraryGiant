import test from 'node:test'
import assert from 'node:assert/strict'
import {captureContext} from '../src/context-capture.js'

const text = value => [{type:'text', text:value}]
const message = (role, source, value='abcdefgh') => ({role, source, content:text(value)})

test('captures system, schemas, message roles and injection source precedence', () => {
  const result = captureContext({system:'abcdefgh', tools:[{name:'lg_lookup', parameters:{type:'object'}}], messages:[
    message('system'), message('user', {kind:'user'}), message('user'),
    message('user', {kind:'agent-instructions'}), message('user', {kind:'user',form:''}),
    message('developer', {kind:'skill-invocation'}), message('assistant', {kind:'skill-invocation'}),
    message('tool', {kind:'skill-invocation'}), message('user', {kind:'skill-invocation',name:'outline'}),
    message('user', {kind:'skill-catalog',sections:[{name:'review'}]}), message('future-role'),
  ]})
  assert.equal(result.tokens.system, 12)
  assert.equal(result.tokens.user, 20)
  assert.equal(result.tokens.developer, 30)
  assert.equal(result.tokens.skill, 20)
  assert.equal(result.tokens.assistant, 10)
  assert.equal(result.tokens.tool, 10)
  assert.equal(result.tokens.other, 10)
  assert.ok(result.tokens.schemas > 0)
  assert.deepEqual(result.items, {system:2,schemas:1,user:2,developer:3,skill:2,assistant:1,tool:1,other:1})
  assert.deepEqual(result.tools, ['lg_lookup'])
  assert.deepEqual(result.skills, ['outline','review'])
})

test('empty request is zero and empty message overhead follows dsh-context', () => {
  assert.deepEqual(captureContext().tokens, {system:0,schemas:0,user:0,developer:0,skill:0,assistant:0,tool:0,other:0})
  const result = captureContext({system:'',tools:[],messages:[
    {role:'system',content:[]},{role:'assistant',content:[]},{role:'developer',content:[]},
    {role:'user',content:[]},{role:'tool',content:[]},
  ]})
  assert.equal(result.tokens.system, 0)
  assert.equal(result.tokens.assistant, 0)
  assert.equal(result.tokens.developer, 0)
  assert.equal(result.tokens.user, 4)
  assert.equal(result.tokens.tool, 4)
})

test('multimodal estimation uses image dimensions and includes structural blocks', () => {
  const image = {type:'image',attachment:{width:512,height:512,attachmentId:'private-image-reference'}}
  const measured = captureContext({messages:[{role:'user',content:[image]}]})
  assert.ok(measured.tokens.user > 100)
  assert.ok(measured.tokens.user <= 392)
  const renamed = captureContext({messages:[{role:'user',content:[{...image,attachment:{...image.attachment,attachmentId:'different'}}]}]})
  assert.equal(measured.tokens.user, renamed.tokens.user)
  const extended = captureContext({messages:[{role:'user',content:[image,{type:'audio',source:'fixture'}]}]})
  assert.ok(extended.tokens.user > measured.tokens.user)
})

test('skill result follows dsh-context skill reclassification without retaining its body', () => {
  const result = captureContext({messages:[
    {role:'assistant',content:[{type:'tool-call',callId:'call-1',name:'skill',arguments:'{}'}]},
    {role:'tool',toolCallId:'call-1',content:text('<skill_content name="outline">PRIVATE_SKILL_BODY</skill_content>')},
  ]})
  assert.deepEqual(result.skills, ['outline'])
  assert.equal(result.tokens.tool, 0)
  assert.equal(result.items.skill, 1)
  assert.ok(result.tokens.skill > 0)
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SKILL_BODY'))
})

test('unrelated tool content does not supply skill names', () => {
  const result = captureContext({messages:[
    {role:'assistant',content:[{type:'tool-call',callId:'call-1',name:'web_fetch',arguments:'{}'}]},
    {role:'tool',toolCallId:'call-1',content:text('<skill_content name="not-a-loaded-skill">page text</skill_content>')},
  ]})
  assert.deepEqual(result.skills, [])
})

test('estimates remain explicitly separate from actual usage and never retain original text', () => {
  const options = {system:'PRIVATE_SYSTEM', tools:[{name:'lookup',description:'PRIVATE_DESCRIPTION',parameters:{type:'object'}}],
    messages:[message('user',{kind:'user',summary:'PRIVATE_SUMMARY'},'PRIVATE_USER'),message('assistant',undefined,'PRIVATE_ANSWER')],
    usage:{inputTokens:998877,outputTokens:665544,cacheReadTokens:332211}}
  const result = captureContext(options)
  assert.equal(result.estimator, 'dsh-context/0.82.1')
  assert.deepEqual(Object.keys(result), ['version','estimator','tokens','items','tools','skills'])
  assert.deepEqual(result, captureContext({...options,usage:{inputTokens:1,outputTokens:2}}))
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
  assert.ok(!JSON.stringify(result).includes('998877'))
})

test('name metadata is deduplicated and bounded', () => {
  const result = captureContext({tools:[{name:' lookup\n '},{name:'lookup'},...Array.from({length:80},(_,i)=>({name:`tool_${i}_${'a'.repeat(200)}`}))],
    messages:Array.from({length:80},(_,i)=>message('user',{kind:'skill-invocation',name:`skill_${i}_${'b'.repeat(200)}`}))})
  assert.equal(result.tools.length, 64)
  assert.equal(result.tools[0], 'lookup')
  assert.equal(result.skills.length, 64)
  assert.ok([...result.tools,...result.skills].every(name=>name.length<=160 && !/[\r\n]/.test(name)))
})

test('malformed optional content cannot break instrumentation', () => {
  const result = captureContext({tools:null,messages:[null,{role:'user',content:'text'},{role:'tool',content:[null,{type:'image',attachment:{width:NaN,height:0}}]}]})
  assert.ok(Object.values(result.tokens).every(value=>Number.isFinite(value)&&value>=0))
  assert.equal(result.items.user, 1)
  assert.equal(result.items.tool, 1)
})
