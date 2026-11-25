import {storySectionLabels} from '../../lg-books/src/story-data/labels.js'

export const storySections=[
 {id:'people',title:storySectionLabels.people,icon:'person',description:'从一个人物出发，查看其内在、认知与变化。',topics:['人物简介','性格与侧写','认知与状态','经历与关系']},
 {id:'plot',title:storySectionLabels.plot,icon:'plot',description:'沿故事发展整理事件、章节与叙事节奏。',topics:['具体情节','章节梗概','伏笔与线索','读者揭示','节奏与情绪']},
 {id:'world',title:storySectionLabels.world,icon:'world',description:'查看世界的规则，以及情节发生的地点。',topics:['世界设定','读者揭露','地点档案','情节场景']},
]
export const personAreas=[
 {id:'profile',title:'人物简介',description:'身份、别名与背景',icon:'person'},
 {id:'portrait',title:'性格与侧写',description:'性格倾向、动机与行为方式',icon:'tool'},
 {id:'knowledge',title:'人物认知',description:'知道什么、相信什么与认知变化',icon:'data'},
 {id:'state',title:'人物状态',description:'处境、身体与其他状态变化',icon:'gauge'},
 {id:'experience',title:'人物经历',description:'参与的事件及前后变化',icon:'clock'},
 {id:'relation',title:'人物关系',description:'与其他人物的联系和变化',icon:'agent'},
]
export const personTabs=personAreas.map(({id,title})=>[id,title])
export function peopleLayout(width,view){
 if(view==='pack')return {columns:1,pageSize:6}
 const compact=view==='list',gap=compact?6:10
 const minimum=compact?(width<400?136:155):(width<400?147:188)
 const columns=Math.max(1,Math.floor((width+gap)/(minimum+gap)))
 return {columns,pageSize:Math.min(200,columns*(compact?5:2))}
}
export function sectionStats(data){
 const count=type=>data?.counts[type]??0,entities=data?.entities??[]
 return {
  people:[['人物',entities.filter(e=>e.kind==='character').length],['侧写',count('portrait')],['关系',count('relation')]],
  plot:[['事件',count('event')],['线索',count('thread')],['分析',count('analysis')]],
  world:[['设定',count('world_rule')],['地点',entities.filter(e=>e.kind==='place').length],['场景',count('scene')]],
 }
}
// Preserve the service's partial order. Filtering a person never invents new time edges.
export function timelineItems(value,subject=''){
 const byId=new Map(value.records.map(r=>[r.id,r]))
 const visible=id=>{const r=byId.get(id);return r?.type==='event'&&(!subject||r.payload.actors.includes(subject))}
 const result=[],seen=new Set()
 for(const [index,group] of value.timeline.groups.entries()){
  for(const id of group.events)if(visible(id)&&!seen.has(id)){seen.add(id);result.push({record:byId.get(id),group:`时间关系组 ${index+1}`})}
 }
 for(const id of value.timeline.unplaced)if(visible(id)&&!seen.has(id)){seen.add(id);result.push({record:byId.get(id),group:'时间待定位'})}
 return result
}
