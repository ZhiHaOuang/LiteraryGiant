import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { containedFile } from './read.js'
import { chapterPath, hash } from './chapter-file-format.js'

const fields = {
  characters:['id','name','role','summary'], events:['id','label','summary','planned'],
  relationships:['source','target','label'], links:['source','target','label'],
}

export function appendGraph(add, graph, prefix, evidence) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).some(key => !Object.hasOwn(fields,key))) throw new Error('故事索引分类无效。')
  const result = {}
  for (const [group,keys] of Object.entries(fields)) {
    const rows = Object.hasOwn(graph,group) ? graph[group] : []
    if (!Array.isArray(rows) || rows.length > 200) throw new Error('单个来源每类最多 200 项。')
    result[group] = rows.map(row => {
      if (!row || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row,key) ||
        (key === 'planned' ? typeof row[key] !== 'boolean' : typeof row[key] !== 'string' || !row[key].trim() || [...row[key]].length > 1200))) throw new Error('故事索引条目格式错误。')
      const item = { ...row,evidence }
      for (const key of ['id','source','target']) if (Object.hasOwn(item,key)) item[key] = prefix + ':' + item[key]
      return item
    })
  }
  for (const [nodes,edges] of [['characters','relationships'],['events','links']]) {
    const ids = new Set(result[nodes].map(row => row.id))
    if (ids.size !== result[nodes].length || result[edges].some(row => !ids.has(row.source) || !ids.has(row.target))) throw new Error('节点重复或连线缺少端点。')
  }
  for (const group of Object.keys(fields)) for (const item of result[group]) add(group,item)
}

export function appendArtifacts(root,add,issues,markMissing) {
  const dir = chapterPath(root,['ReferenceLibrary'],'indices')
  if (!existsSync(dir)) return
  chapterPath(root,['ReferenceLibrary','indices'],'story.json')
  const names = readdirSync(dir).filter(n => n.startsWith('artifact-') && n.endsWith('.json')).sort()
  if (names.length > 5000) throw new Error('作品材料索引数量超出读取上限。')
  let remaining = 32_000_000
  for (const name of names) {
    try {
      const read = (path,limit) => {
        const bytes = readFileSync(containedFile(root,path,Math.min(remaining,limit)))
        remaining -= bytes.length
        return bytes
      }
      const record = JSON.parse(read(join('ReferenceLibrary','indices',name),2_000_000))
      if (typeof record.path !== 'string' || isAbsolute(record.path) || record.path.split(/[\\/]/u).some(part => !part || part === '..' || part === '.') ||
          name !== 'artifact-' + hash(record.path) + '.json' || typeof record.state !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error('材料索引身份无效。')
      if (hash(read(record.path,8_000_000)) !== record.sha256) { markMissing({source:record.path,reason:'changed-artifact'}); continue }
      if (record.display === false) continue
      appendGraph(add,record.graph,name.slice(0,-5),{state:record.state,document:record.path,
        kind:record.path.startsWith('ReferenceLibrary/plans/outlines/') ? 'outline' : 'artifact',sha256:record.sha256})
    } catch (error) {
      if (error instanceof RangeError) throw error
      issues.push(name + '：' + error.message)
    }
  }
}
