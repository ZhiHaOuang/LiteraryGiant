import {heads, initialized, packList} from './storage.js'
import {characterProtocol} from './character-core.js'

// A structured module contributes one row per entry. All other modules hold one summary.
// An empty entries array is a reviewed module with zero entries.
const entries = heads + `JOIN json_each(COALESCE(json_extract(r.item,'$.entries'),
  json_array(json_object('value',json_extract(r.item,'$.text'))))) e `
const facet = "json_extract(e.value,'$.facet')"
const count = rows => rows.reduce((n,row)=>n+row.count,0)

function usage(db) {
  const groups=initialized(db) ? db.prepare('SELECT r.section,h.module,'+facet+' AS facet,count(*) AS count'+entries+
    'GROUP BY r.section,h.module,facet ORDER BY r.section,h.module,facet').all() : []
  const hasExtraction=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lg_story_data_records'").get()
  const extracted=hasExtraction ? db.prepare(`SELECT r.type,v.approval,count(*) AS count FROM lg_story_data_records r
    JOIN lg_story_data_revisions v ON v.id=r.head GROUP BY r.type,v.approval ORDER BY r.type,v.approval`).all() : []
  return {groups,main:count(groups),extracted,records:count(extracted)}
}

export function overview(books,{locale,includeArchived=false}={}) {
  const shelf=books.list({includeArchived:includeArchived===true}).map(({path,name,archived,error})=>{
    const book={path,name,archived:Boolean(archived)}
    if(error) return {...book,error}
    try { return {...book,...books.readState(path,usage)} }
    catch(err) { return {...book,error:err.message} }
  })
  const totals=shelf.reduce((total,b)=>{
    if(!b.error){total.main+=b.main;total.records+=b.records}
    return total
  },{main:0,records:0})
  return {version:'lg.storydata.inventory.v1',protocol:characterProtocol(locale),books:shelf,totals}
}

export function bookInventory(books,path,{offset=0,module,facet:category,section}={}) {
  if(!Number.isSafeInteger(offset)||offset<0 || [module,category].some(v=>v!==undefined&&(typeof v!=='string'||v.length>100))
      || (section!==undefined&&!['people','plot','world'].includes(section))) throw Error('条目筛选或分页参数无效')
  return books.readState(path,db=>{
    const summary=usage(db)
    const total=count(summary.groups.filter(g=>(!module||module===g.module)&&(!category||category===g.facet)&&(!section||section===g.section)))
    const limit=30, filters=[],args=[]
    for(const [column,value] of [['h.module',module],[facet,category],['r.section',section]]) {
      if(value){filters.push(column+'=?');args.push(value)}
    }
    const where=filters.length?'WHERE '+filters.join(' AND ')+' ':''
    const items=total ? db.prepare(`SELECT h.id,h.module,h.revision,r.section,json_extract(r.item,'$.title') AS title,
      json_extract(e.value,'$.key') AS key,`+facet+` AS facet,json_extract(e.value,'$.value') AS value,
      json_extract(e.value,'$.tags') AS tags,json_extract(e.value,'$.scope') AS scope`+entries+where+
      'ORDER BY r.section,h.id,h.module,e.key LIMIT ? OFFSET ?').all(...args,limit,offset)
      .map(row=>({...row,tags:JSON.parse(row.tags??'[]')})) : []
    return {version:'lg.storydata.inventory.v1',...summary,packs:packList(db),items,total,limit,offset}
  })
}
