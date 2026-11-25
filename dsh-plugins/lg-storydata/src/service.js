import {characterGroups,characterProtocol} from './character-core.js'
import {validateChange,validatePack,identity,fingerprint,sections} from './contracts.js'
import {ensureSchema,initialized,bookId,heads,packList,revision,sourceCheck,compareBatch} from './storage.js'

const readVersion = 'lg.outline.read.v1'
const receipt = row => ({token:row.token,status:row.status})
function candidate(db,token) {
  if (!initialized(db)) throw Error('找不到这次更新')
  const row = db.prepare('SELECT * FROM lg_outline_changes WHERE token=?').get(token)
  if (!row) throw Error('找不到这次更新')
  return row
}
function page(options) {
  const {offset=0,limit=30} = options
  if (!Number.isSafeInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>100) throw Error('分页无效')
  return {offset,limit}
}

function presentRows(db,rows) {
  const check=sourceCheck(db)
  const target=db.prepare("SELECT r.section,json_extract(r.item,'$.title') AS title"+heads+'WHERE h.id=? LIMIT 1')
  return rows.map(row=>{
    const {id,section,module,title,text,basis,links,evidence,entries}=JSON.parse(row.item)
    const targets=links.map(id=>({id,...target.get(id)}))
    return {id,section,module,title,text,basis,links,related:targets.map(({id,title})=>({id,title})),
      related_sections:Object.fromEntries(targets.map(({id,section})=>[id,section])),
      ...(entries && {entries:entries.map(({sources,...entry})=>entry)}),
      revision:row.revision,standing:'reviewed_summary',freshness:evidence.every(check)?'current':'stale'}
  })
}

export function createOutline(books) {
  return {
    characterProtocol,
    character(path,options) {
      if (!options || Object.keys(options).join()!=='id' || typeof options.id!=='string'
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(options.id)) throw Error('需要单个人物档案 ID')
      const {id}=options
      return books.readState(path,db=>{
        const modules=characterGroups.map(g=>g.module)
        const rows=initialized(db) ? db.prepare('SELECT r.item,h.revision'+heads+
          "WHERE h.id=? AND r.section='people' AND h.module IN ("+modules.map(()=>'?').join(',')+")").all(id,...modules) : []
        const items=new Map((rows.length?presentRows(db,rows):[]).map(item=>[item.module,item]))
        return {api_version:'lg.outline.character.v1',book_id:bookId(db),id,groups:characterGroups.map(({module,label,facets})=>({
          module,label,facets:facets.map(({id,label})=>({id,label})),item:items.get(module)??null}))}
      })
    },
    packs(path) { return books.readState(path,db=>structuredClone(packList(db))) },
    enablePack(path,pack) {
      validatePack(pack)
      return books.changeState(path,db=>{
        ensureSchema(db)
        const prior = db.prepare('SELECT spec FROM lg_outline_packs WHERE id=?').get(pack.id)
        if (prior && fingerprint(JSON.parse(prior.spec)) !== fingerprint(pack)) throw Error('本书已固定此包的版本和定义')
        db.prepare('INSERT OR IGNORE INTO lg_outline_packs(id,spec) VALUES(?,?)').run(pack.id,JSON.stringify(pack))
        return {id:pack.id,version:pack.version}
      })
    },
    propose(path,proposal,actor) {
      validateChange(proposal)
      actor = identity(actor)
      return books.changeState(path,db=>{
        if (bookId(db) !== proposal.book_id) throw Error('更新与作品标识不一致')
        ensureSchema(db)
        const token = fingerprint({actor,proposal})
        const prior = db.prepare('SELECT token,status FROM lg_outline_changes WHERE token=?').get(token)
        if (prior) return receipt(prior)
        const changes = compareBatch(db,proposal)
        if (!changes.length) return {token:null,status:'no_change'}
        const payload = JSON.stringify({...proposal,changes})
        db.prepare("INSERT INTO lg_outline_changes(token,actor,payload,status) VALUES(?,?,?,'pending')").run(token,actor,payload)
        return {token,status:'pending'}
      })
    },
    inspect(path,token) {
      return books.readState(path,db=>{
        const row = candidate(db,token), proposal = JSON.parse(row.payload)
        return {...receipt(row),actor:row.actor, reviewer:row.reviewer, reason:row.reason, book_id:proposal.book_id, beat:proposal.beat,
          changes:proposal.changes.map(after=>({before:revision(db,after.id,after.module,after.expected_revision),after}))}
      })
    },
    review(path,token,{decision,reason},reviewer) {
      reviewer = identity(reviewer)
      if (!['approved','rejected'].includes(decision) || typeof reason !== 'string' || !reason.trim() || reason.length>1000) throw Error('需要有效的审查决定和理由')
      return books.changeState(path,db=>{
        const row = candidate(db,token)
        if (row.actor === reviewer) throw Error('提议人与审查人须独立')
        if (row.status !== 'pending') {
          if ((row.status===decision || (row.status==='committed' && decision==='approved')) && row.reviewer===reviewer && row.reason===reason) return receipt(row)
          throw Error('该版本已经审查')
        }
        if (decision==='approved') compareBatch(db,JSON.parse(row.payload))
        db.prepare('UPDATE lg_outline_changes SET status=?,reviewer=?,reason=? WHERE token=?').run(decision,reviewer,reason,token)
        return {token,status:decision}
      })
    },
    commit(path,token) {
      return books.changeState(path,db=>{
        const row = candidate(db,token)
        if (row.status==='committed') return receipt(row)
        if (row.status!=='approved') throw Error('此更新尚未通过审查')
        const changes = compareBatch(db,JSON.parse(row.payload))
        const insert = db.prepare('INSERT INTO lg_outline_revisions(id,module,revision,section,token,item) VALUES(?,?,?,?,?,?)')
        const advance = db.prepare(`INSERT INTO lg_outline_heads(id,module,revision) VALUES(?,?,?)
          ON CONFLICT(id,module) DO UPDATE SET revision=excluded.revision`)
        for (const item of changes) {
          const number = item.expected_revision+1
          insert.run(item.id,item.module,number,item.section,token,JSON.stringify(item))
          advance.run(item.id,item.module,number)
        }
        db.prepare("UPDATE lg_outline_changes SET status='committed' WHERE token=?").run(token)
        return {token,status:'committed'}
      })
    },
    main(path,options={}) {
      if (!options || typeof options!=='object' || Array.isArray(options) ||
          Object.keys(options).some(key=>!['section','id','limit','offset','other_modules'].includes(key))) {
        throw Error('Main 仅支持作者当前视图，请使用有效的查询条件')
      }
      const {section,id} = options, {limit,offset} = page(options)
      if (section!==undefined && !sections.includes(section)) throw Error('未知板块')
      if (id!==undefined && (typeof id!=='string' || !id.length || id.length>120)) throw Error('档案 ID 无效')
      if (options.other_modules!==undefined && (options.other_modules!==true || section!=='people' || !id)) throw Error('其他模块需指定人物档案')
      return books.readState(path,db=>{
        const result = {api_version:readVersion,book_id:bookId(db),offset,limit,total:0,items:[]}
        if (!initialized(db)) return result
        const filters = [], args = []
        if (section!==undefined) { filters.push('r.section=?'); args.push(section) }
        if (id!==undefined) { filters.push('h.id=?'); args.push(id) }
        if (options.other_modules) {
          const modules=characterGroups.map(g=>g.module)
          filters.push('h.module NOT IN ('+modules.map(()=>'?').join(',')+')')
          args.push(...modules)
        }
        const from = heads + (filters.length ? ' WHERE '+filters.join(' AND ') : '')
        result.total = db.prepare('SELECT count(*) AS n'+from).get(...args).n
        const rows = db.prepare('SELECT r.item,h.revision'+from+' ORDER BY h.id,h.module LIMIT ? OFFSET ?').all(...args,limit,offset)
        result.items = presentRows(db,rows)
        return result
      })
    },
    history(path,{id,module,...options}) {
      const {offset,limit} = page(options)
      return books.readState(path,db=>{
        if (!initialized(db)) return []
        return db.prepare(`SELECT r.revision,r.item,c.token,c.actor,c.reviewer,c.reason,json_extract(c.payload,'$.beat') AS beat
          FROM lg_outline_revisions r JOIN lg_outline_changes c USING(token) WHERE id=? AND module=?
          ORDER BY revision DESC LIMIT ? OFFSET ?`).all(id,module,limit,offset).map(row=>({...row,item:JSON.parse(row.item)}))
      })
    }
  }
}

