import {createHash} from 'node:crypto'
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const hanCount=value=>(value.match(/\p{Script=Han}/gu)??[]).length
export function text(value,label,max=4000){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'为空或过长');return value}
function strings(value,label,max=16){if(!Array.isArray(value))throw Error(label+'必须提供字符串数组；没有内容用 []，不得省略');if(value.length>max)throw Error(label+'当前 '+value.length+' 项，最多 '+max+' 项，请合并或缩减');value.forEach(v=>text(v,label,2000));return value}
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('候选含未知字段或格式错误')}
export function validateArtifact(role,value,source,optionCount=1){
  if(Buffer.byteLength(JSON.stringify(value)??'')>80000)throw Error('候选超过 80 KB')
  text(value?.summary,'摘要',2000)
  if(role==='planning'&&Array.isArray(value.alternatives))for(const a of value.alternatives){const missing=['id','title','premise','beats','tradeoffs'].filter(k=>a?.[k]===undefined);if(missing.length)throw Error('每个方案缺少字段：'+missing.join('、')+'；请重交完整对象，不能只交修改的字段')}
  if(role==='analysis'){
    keys(value,['summary','findings','unknowns'])
    if(!Array.isArray(value.findings)||!value.findings.length||value.findings.length>8)throw Error('分析需 1—8 项发现；优先交付 3—5 项，不求穷尽')
    for(const f of value.findings){
      keys(f,['kind','category','claim','evidence']);text(f.claim,'判断',2000)
      if(!['observation','inference'].includes(f.kind)||!['plot','character','knowledge','world','reader','thread','style'].includes(f.category))throw Error('分析类型无效')
      if(!Array.isArray(f.evidence)||!f.evidence.length||f.evidence.length>4)throw Error('每项发现需要 1—4 处证据')
      for(const e of f.evidence){keys(e,['chapter','paragraph','quote']);text(e.quote,'引文',500)
        const ch=source.chapters.find(c=>c.number===e.chapter)
        if(!ch)throw Error('引文章号超出授权范围；可用章号：'+source.chapters.map(c=>c.number).join('、'))
        if(!Number.isInteger(e.paragraph)||e.paragraph<1||e.paragraph>ch.paragraphs.length)throw Error(`第 ${e.chapter} 章段落号无效；可用 1—${ch.paragraphs.length}`)
        if(!ch.paragraphs[e.paragraph-1].includes(e.quote))throw Error(`引文不在授权章节段落中：第 ${e.chapter} 章第 ${e.paragraph} 段，需逐字引用，请重新读取该段；错误引文：${e.quote.slice(0,100)}`)
      }
    }
    strings(value.unknowns,'未知')
  }else if(role==='planning'){
    keys(value,['summary','alternatives','constraints','open_questions'])
    if(!Array.isArray(value.alternatives)||value.alternatives.length!==optionCount)throw Error('本任务必须提交 '+optionCount+' 个方案')
    strings(value.constraints,'约束',8);strings(value.open_questions,'待决问题',6)
    const ids=new Set()
    for(const a of value.alternatives){keys(a,['id','title','premise','beats','tradeoffs']);for(const k of ['id','title','premise'])text(a[k],k,2000)
      if(ids.has(a.id))throw Error('方案 ID 重复');ids.add(a.id);strings(a.beats,'场景步骤',8);if(!a.beats.length)throw Error('方案缺少步骤');strings(a.tradeoffs,'取舍',6)}
    strings(value.constraints,'约束',8);strings(value.open_questions,'待决问题',6)
  }else if(role==='writing'){
    keys(value,['summary','text','checks','open_questions']);text(value.text,'正文',24000);strings(value.checks,'检查');strings(value.open_questions,'待决问题')
    const n=hanCount(value.text),min=source.constraints?.min_han??0,max=source.constraints?.max_han??20000
    if(n<min||n>max)throw Error(`正文实测 ${n} 汉字，要求 ${min}—${max}；标点、数字、空白不计入。请修改正文再提交，不要只改自报字数。`)
  }else throw Error('未知职责')
  return JSON.parse(JSON.stringify(value))
}
export const objectSchema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false})
const str={type:'string'},list={type:'array',items:str},evidence=objectSchema({chapter:{type:'integer'},paragraph:{type:'integer'},quote:str})
export const artifactSchemas={
  analysis:objectSchema({summary:str,findings:{type:'array',items:objectSchema({kind:{type:'string',enum:['observation','inference']},category:{type:'string',enum:['plot','character','knowledge','world','reader','thread','style']},claim:str,evidence:{type:'array',items:evidence}})},unknowns:list}),
  planning:objectSchema({summary:str,alternatives:{type:'array',items:objectSchema({id:str,title:str,premise:str,beats:list,tradeoffs:list})},constraints:list,open_questions:list}),
  writing:objectSchema({summary:str,text:str,checks:list,open_questions:list}),
}
