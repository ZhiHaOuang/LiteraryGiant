import {test} from 'node:test'
import assert from 'node:assert/strict'
import {cardIntro,chapterRange,characterRoleView,firstSentence,previousLabel,recordQualifier} from '../src/story-fields.js'
const assignment=(prominence='core',scope='arc',approval='candidate')=>({prominence,roles:['protagonist'],approval,scope:{kind:scope,description:'仅前二十章',targets:[]},story_time:{kind:'all'}})
test('stage identities retain their range, roles and candidate status without becoming whole-book rank',()=>{
 const value=characterRoleView({status:'scoped',prominence:'unknown',roles:[],assignments:[assignment()]})
 assert.deepEqual(value,{label:'阶段 · 核心人物',roles:'主角',approval:'候选评级',detail:'候选评级 · 主角',scope:'仅前二十章'})
 assert.equal(characterRoleView({status:'scoped',assignments:[assignment('core','chapter')]}).label,'限定范围 · 核心人物')
 assert.equal(characterRoleView({status:'scoped',assignments:[assignment(),assignment('minor')]}).label,'多范围身份')
 assert.equal(characterRoleView({status:'unrated',assignments:[]}).label,'未评级')
})
test('whole-book approved roles remain distinct from a conflicting candidate or scoped assignment',()=>{
 const role={status:'rated',prominence:'minor',approval:'confirmed',roles:['ally'],assignments:[assignment('minor','book','confirmed'),assignment('core','book'),assignment()]}
 assert.deepEqual(characterRoleView(role),{label:'次要人物',roles:'伙伴',approval:'已确认评级',detail:'已确认评级 · 伙伴',scope:''})
 assert.equal(characterRoleView({...role,status:'conflict'}).label,'评级待核对')
})
test('predecessor labels distinguish knowledge and relationship from physical state',()=>{
 assert.equal(previousLabel('knowledge'),'此前认知')
 assert.equal(previousLabel('relation'),'此前关系')
 assert.equal(previousLabel('state'),'此前状态')
 assert.equal(recordQualifier({type:'knowledge',payload:{topic:'life-status'}}),'认知主题：life-status')
 assert.equal(recordQualifier({type:'revelation',payload:{presentation:'statement'}}),'人物陈述')
})

test('compact cards use one sentence and only an explicit chapter range',()=>{
 assert.equal(cardIntro('原为绘图员，现任领主，拥有浅灰色卷发，正在边陲镇执政。'),'原为绘图员，现任领主。')
 assert.equal(cardIntro('守灯人以为船已靠岸；但那只是倒影。'),'守灯人以为船已靠岸；但那只是倒影。')
 assert.equal(cardIntro('在港口守灯；第二章登记了他的姓名。'),'在港口守灯。')
 assert.equal(cardIntro('', '初登场时是船夫。随后离开。'),'初登场时是船夫。')
 assert.equal(firstSentence('他在海岛守灯。之后离岛。'),'他在海岛守灯。')
 assert.equal(firstSentence(null),'')
 assert.equal(chapterRange('仅根据已整理的第 1—20 章判断，不代表全书排名或未来身份。'),'第 1–20 章')
 assert.equal(chapterRange('仅前二十章'),'前二十章')
 assert.equal(chapterRange('成年以后'),'')
})
