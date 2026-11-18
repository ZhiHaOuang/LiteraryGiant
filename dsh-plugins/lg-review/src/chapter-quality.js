import { hash } from './targets.js'

const adopted = state => state === 'accepted' || state === 'final'
const inactive = state => ['candidate','rejected','archived'].includes(state)
const lineBreak = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u
function strip(text) {
  const space=/[\p{White_Space}\x1c-\x1f]/u
  let start=0,end=text.length
  while(start<end&&space.test(text[start]))start++
  while(end>start&&space.test(text[end-1]))end--
  return text.slice(start,end)
}

function measure(text) {
  const wordCount = (text.match(/[\u4e00-\u9fff]|[a-z0-9]+(?:['-][a-z0-9]+)?/gi) ?? []).length
  const lines = text.split(lineBreak).map(strip).filter(Boolean)
  const ending = lines.at(-1) ?? ''
  let dialogue = 0
  for (const match of text.matchAll(/["“][^"”]{1,300}["”]/gu)) dialogue += [...match[0]].length
  const ratio = dialogue / Math.max(1,[...text].length)
  // Exactly representable halfway cases follow Python's round-to-even.
  const dialogueRatio = Number.isInteger(ratio*16) && !Number.isInteger(ratio*8)
    ? Math.round(ratio*500)*2/1000 : Number(ratio.toFixed(3))
  return {wordCount,paragraphCount:lines.length,dialogueRatio,
    endingHookSignal:/[？！?!]|却|然而|未完|门外|but|however|suddenly|unknown/iu.test(ending),ending}
}

export function chapterQuality(books,path,target,receiptOnly=false) {
  if (target?.section !== 'quality' || !Number.isSafeInteger(target.id) || target.id<1) throw new Error('请选择要检查的章节。')
  const selected = {section:'quality',id:target.id}
  return books.readState(path,db=>{
    const chapter = db.prepare(`SELECT d.id,d.state,d.active_version_id AS version,v.state AS version_state,substr(v.content,1,400001) AS content
      FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.id=d.active_version_id WHERE d.id=? AND d.kind='chapter'`).get(target.id)
    if (!chapter || inactive(chapter.state) || inactive(chapter.version_state)) throw new Error('章节没有可检查的当前正文。')
    const scenes = db.prepare(`SELECT c.document_id AS id,c.status,c.chapter_id,d.kind,d.state,d.parent_id,d.sequence,
      v.id AS version,v.state AS version_state,CASE WHEN c.status IN ('accepted','final') THEN substr(v.content,1,400001) END AS content
      FROM scene_cards c LEFT JOIN documents d ON d.id=c.document_id LEFT JOIN document_versions v ON v.document_id=d.id AND v.id=d.active_version_id
      WHERE c.chapter_id=? OR d.parent_id=? ORDER BY coalesce(nullif(d.sequence,0),999999),c.document_id LIMIT 1001`).iterate(target.id,target.id)
    const parts=[],sources=[],cards=[]
    let total=0,acceptedSceneCount=0
    function include(row) {
      if (typeof row.content!=='string' || row.content.length>400000) throw new Error('章节正文超过质量报告读取上限。')
      total+=row.content.length
      if (total>1000000) throw new Error('章节正文超过质量报告读取上限。')
      sources.push({document:row.id,version:row.version})
      if (strip(row.content)) parts.push(row)
    }
    include(chapter)
    for (const scene of scenes) {
      if (cards.length>=1000) throw new Error('章节场景卡超过质量报告读取上限。')
      if (scene.kind!=='scene' || scene.chapter_id!==target.id || scene.parent_id!==target.id || !scene.version) throw new Error('场景卡归属或当前版本不完整。')
      cards.push([scene.id,scene.status])
      if (!adopted(scene.status)) continue
      if (!adopted(scene.state) || !adopted(scene.version_state)) throw new Error('场景卡与当前正文的采用状态不一致，请核对后检查。')
      acceptedSceneCount++;include(scene)
    }
    const receipt={schema:'lg.chapter-quality.v1',target:selected,binding:hash([sources,parts.map(row=>[row.id,hash(row.content)]),cards])}
    if (receiptOnly) return receipt
    const text=parts.map(row=>strip(row.content)).join('\n\n')
    const {ending,...metrics}=measure(text),last=parts.at(-1)
    let excerpt=null
    if (last) {
      const quote=[...ending].slice(-180).join(''),start=last.content.lastIndexOf(ending)+ending.length-quote.length
      excerpt={label:'章末原文',quote,anchor:{section:'manuscript',document:last.id,version:last.version,start,end:start+quote.length}}
    }
    const summary={...metrics,sceneCount:cards.length,acceptedSceneCount,sources,excerpt}
    const issues=[]
    const add=(category,message,suggestion,evidence=[])=>issues.push({category,message,suggestion,evidence,severity:category==='hook'?'info':'warning'})
    if (cards.length&&!acceptedSceneCount) add('workflow','本章已有场景卡，尚无已采用的场景正文。','核对场景是否仍在起草。')
    if (metrics.wordCount<200&&(strip(chapter.content)||acceptedSceneCount)) add('length',`本章估算 ${metrics.wordCount} 字，少于旧版提示阈值 200 字。`,'核对篇幅是否符合本章目标。')
    if (excerpt&&!metrics.endingHookSignal) add('hook','章末未匹配到悬念或转折标记。','阅读末段，判断是否需要留下问题，或保留平缓的收束。',[excerpt])
    return {target:selected,receipt,context:{receipt:null},summary,issues}
  })
}
