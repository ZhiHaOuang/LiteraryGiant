import {test} from 'node:test'
import assert from 'node:assert/strict'
import {characterRoleView,previousLabel,recordQualifier} from '../src/story-fields.js'
const assignment=(prominence='core',scope='arc',approval='candidate')=>({prominence,roles:['protagonist'],approval,scope:{kind:scope,description:'仅前二十章',targets:[]},story_time:{kind:'all'}})
test('stage identities retain their range, roles and candidate status without becoming whole-book rank',()=>{
 const value=characterRoleView({status:'scoped',prominence:'unknown',roles:[],assignments:[assignment()]})
 assert.deepEqual(value,{label:'阶段 · 核心人物',detail:'候选评级 · 主角',scope:'仅前二十章'})
 assert.equal(characterRoleView({status:'scoped',assignments:[assignment('core','chapter')]}).label,'限定范围 · 核心人物')
 assert.equal(characterRoleView({status:'scoped',assignments:[assignment(),assignment('minor')]}).label,'多范围身份')
 assert.equal(characterRoleView({status:'unrated',assignments:[]}).label,'未评级')
})
test('whole-book approved roles remain distinct from a conflicting candidate or scoped assignment',()=>{
 const role={status:'rated',prominence:'minor',approval:'confirmed',roles:['ally'],assignments:[assignment('minor','book','confirmed'),assignment('core','book'),assignment()]}
 assert.deepEqual(characterRoleView(role),{label:'次要人物',detail:'已确认评级 · 伙伴',scope:''})
 assert.equal(characterRoleView({...role,status:'conflict'}).label,'评级待核对')
})
test('predecessor labels distinguish knowledge and relationship from physical state',()=>{
 assert.equal(previousLabel('knowledge'),'此前认知')
 assert.equal(previousLabel('relation'),'此前关系')
 assert.equal(previousLabel('state'),'此前状态')
 assert.equal(recordQualifier({type:'knowledge',payload:{topic:'life-status'}}),'认知主题：life-status')
 assert.equal(recordQualifier({type:'revelation',payload:{presentation:'statement'}}),'人物陈述')
})
