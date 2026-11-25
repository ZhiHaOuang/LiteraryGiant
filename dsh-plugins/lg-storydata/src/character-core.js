import groups from './character-core.json' with {type:'json'}
import {englishCharacterGroups} from './character-core-labels.js'
import contract from './contract.json' with {type:'json'}

export const characterGroups = groups
const byModule = new Map(groups.map(group=>[group.module,group]))
const entrySchema = structuredClone(contract.$defs.characterEntry)
for (const field of ['key','event_id','related_event_id','target_id']) entrySchema.properties[field] = contract.$defs.id

const reviewRules=[
  {zh:'按人物及模块比较和替换完整条目集。保留仍有效的旧条目及其 key。无变化跳过，条目清空也需证据和独立审查。',
   en:'Compare and replace the complete set of entries for one character and module at a time. Keep valid entries and their keys. Skip unchanged modules. Clearing a module requires evidence and independent review.'},
  {zh:'scope 标明适用情境或正文截止点；time 是可选故事内时间。sources 从 1 起指向本模块 evidence。未提及可留空。',
   en:'Use scope for the situation or reading cutoff and time for an optional in-story time. Number sources from 1 within the module’s evidence list. Leave unmentioned details empty.'},
  {zh:'目标 objective 含 span 和 status；progress 含 status。认知条目须标注 stance 和性质；人物持有的判断用 belief。',
   en:'An objective requires span and status. Goal progress requires status. Knowledge entries require stance and nature. Use belief for a judgment held by the character.'},
  {zh:'关系以档案人物为起点，填写 target、direction 和 visibility。承诺与关键经历须经 event_id 引用 links 中的情节。',
   en:'Record a relationship from the dossier character’s perspective with target, direction and visibility. Commitments and milestones must reference a linked plot event through event_id.'},
  {zh:'区分一次选择与长期倾向。仅保留影响辨识、选择、行动、认知或连续性的内容。补证、重复动作和复述留在来源。',
   en:'Distinguish a single choice from a lasting tendency. Keep details that affect identification, choices, actions, knowledge or continuity. Keep corroboration and repeated actions in the sources.'}
]

export function characterProtocol(locale='zh') {
  const localized=locale==='en'
  const catalog=localized?englishCharacterGroups(groups):groups
  return structuredClone({version:'lg.outline.character.v1',groups:catalog,entry_schema:entrySchema,
    rules:reviewRules.map(rule=>localized?rule.en:rule.zh)})
}

export function validateCharacterItem(item) {
  const group = byModule.get(item.module)
  if (!group) {
    if (item.entries !== undefined) throw Error('该模块不接受人物条目')
    return
  }
  if (item.section!=='people' || !Array.isArray(item.entries)) throw Error('人物模块需要 people 板块及 entries')
  const seen = new Set()
  for (const entry of item.entries) {
    if (seen.has(entry.key) || !group.facets.some(facet=>facet.id===entry.facet)) throw Error('人物条目标识重复或二级类别与模块不符')
    seen.add(entry.key)
    if (entry.sources.some(n=>n>item.evidence.length)) throw Error('人物条目缺少对应原文依据')
    if (entry.target_id && (!entry.target || entry.target_id===item.id)) throw Error('对象引用需要独立的对象和显示名')
    if (entry.facet==='sequence' || entry.related_event_id || entry.event_relation) {
      if (entry.facet!=='sequence' || !entry.event_relation || !entry.related_event_id || entry.event_id===entry.related_event_id
          || !item.links.includes(entry.related_event_id)) throw Error('经历关联需要不同的两个情节引用及有向关系')
    }
    if (entry.event_id && !item.links.includes(entry.event_id)) throw Error('经历或承诺须关联情节档案')
    if ((item.module==='core@1.milestones' || entry.facet==='obligation') && !entry.event_id) throw Error('经历或承诺需要 event_id')
    if (item.module==='core@1.relationships' && !(entry.target && entry.direction && entry.visibility)) throw Error('关系需要对象、方向及公开范围')
    if (item.module==='core@1.knowledge' && !entry.stance) throw Error('认知需要持有态度')
    if (entry.facet==='objective' && !(entry.span && entry.status)) throw Error('目标需要跨度与进展')
    if (entry.facet==='progress' && !entry.status) throw Error('目标进展需要状态')
    for (const [field,module] of Object.entries({span:'goals',status:'goals',importance:'identity',stance:'knowledge',direction:'relationships'})) {
      if (entry[field]!==undefined && item.module!=='core@1.'+module) throw Error('人物字段与模块不符 '+field)
    }
    if (entry.importance && entry.facet!=='narrative-role') throw Error('重要程度属于叙事定位')
  }
}
