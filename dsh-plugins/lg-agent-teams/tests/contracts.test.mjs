import test from 'node:test'
import assert from 'node:assert/strict'
import {validateArtifact} from '../src/contracts.js'
import {rolePrompt} from '../src/roles.js'
const source={chapters:[{number:1,document_id:100,paragraphs:['城门已经关闭。她以为守卫仍在桥上。']}]}
const report={summary:'知情范围不一',findings:[{kind:'observation',category:'knowledge',claim:'她相信守卫在桥上',evidence:[{chapter:1,paragraph:1,quote:'她以为守卫仍在桥上'}]}],unknowns:['守卫真实位置']}
test('analysis requires real scoped evidence and separates observation from inference',()=>{
 assert.deepEqual(validateArtifact('analysis',report,source),report)
 for(const change of [{quote:'守卫已经到达城内'},{chapter:2},{paragraph:2}]){
  const bad=structuredClone(report);Object.assign(bad.findings[0].evidence[0],change);assert.throws(()=>validateArtifact('analysis',bad,source),/授权|段落号/)
 }
 const bad=structuredClone(report);bad.findings[0].kind='canonical';assert.throws(()=>validateArtifact('analysis',bad,source),/类型/)
 assert.throws(()=>validateArtifact('analysis',{...report,approved:true},source),/未知字段/)
})
test('planning needs concrete steps; writing preserves full text as a candidate',()=>{
 const plan={summary:'试写方向',alternatives:[{id:'a',title:'查门',premise:'用门闩声反证',beats:['她靠近城门，发现新脚印'],tradeoffs:['保持守卫身份悬念']}],constraints:['不揭露身份'],open_questions:[]}
 assert.deepEqual(validateArtifact('planning',plan,source),plan)
 const bad=structuredClone(plan);bad.alternatives[0].beats=[];assert.throws(()=>validateArtifact('planning',bad,source),/步骤/)
 const draft={summary:'候选',text:'门闩响了。',checks:['没有揭露身份'],open_questions:[]}
 assert.deepEqual(validateArtifact('writing',draft,source),draft)
 assert.throws(()=>validateArtifact('writing',{...draft,text:''},source),/正文/)
})
test('optional method changes only role guidance; no opaque hidden reasoning requirement',()=>{
 for(const role of ['analysis','planning','writing']){
  const base=rolePrompt(role,false),method=rolePrompt(role,true)
  assert.ok(method.startsWith(base));assert.ok(method.length>base.length);assert.match(base,/候选/)
 }
})
test('deterministic length gate rejects false self-reported compliance and counts supplementary Han',()=>{
 const source={constraints:{min_han:5,max_han:8}}
 const short={summary:'自称符合要求',text:'不足。',checks:['500字'],open_questions:[]}
 assert.throws(()=>validateArtifact('writing',short,source),/实测 2 汉字/)
 const valid={...short,text:'城门已关闭𠮷。123😀'}
 assert.deepEqual(validateArtifact('writing',valid,source),valid)
 assert.throws(()=>validateArtifact('writing',{...valid,text:'城门已经关闭但是他还没有回来。'},source),/要求 5—8/)
})

test('repair feedback identifies missing fields together and distinguishes excessive item count',()=>{
 const missing={summary:'概要',alternatives:[{beats:['动作']}],constraints:[],open_questions:[]}
 assert.throws(()=>validateArtifact('planning',missing,source),/id、title、premise、tradeoffs.*完整对象/)
 const plan={summary:'概要',alternatives:[{id:'one',title:'标题',premise:'起点',beats:['动作'],tradeoffs:[]}],constraints:Array(9).fill('约束'),open_questions:[]}
 assert.throws(()=>validateArtifact('planning',plan,source),/约束当前 9 项，最多 8 项/)
})
