import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chapterPath, readText } from './chapter-file-format.js'
import { analysisSnapshots } from './analysis-snapshot.js'
import { verifyReport } from './analysis-report.js'

export function appendAnalyses(book, chapters, readDecision, add, issues, warn) {
  const roots = [['ReferenceLibrary','analyses']]
  if (existsSync(join(book.root,'.literarygiant','analysis'))) {
    const manifest = readText(chapterPath(book.root,['.literarygiant'],'assets.json'),2_000_000)
    if (manifest === null) roots.push(['.literarygiant','analysis'])
    else {
      const data = JSON.parse(manifest)
      if (data.schema !== 'lg.assets.v1' || data.status !== 'complete') throw new Error('作品资料整理尚未完成。')
    }
  }
  const available = roots.filter(parts=>existsSync(join(book.root,...parts)))
  if (!available.length) return
  let makeSnapshot, remaining = 32_000_000
  for (const chapter of chapters) {
    if (!chapter.slug || /[\\/]/u.test(chapter.slug) || ['.','..'].includes(chapter.slug)) throw new Error('章节目录无效。')
    let snapshot
    for (const category of ['CharacterArc','EventsLibrary']) {
      try {
        let raw = null
        for (const root of available) {
          raw = readText(chapterPath(book.root,[...root,chapter.slug],category+'.json'),Math.min(remaining,2_000_000))
          if (raw !== null) break
        }
        if (raw === null) continue
        remaining -= Buffer.byteLength(raw)
        const p = JSON.parse(raw)
        if (p?.schema !== 'lg.book-analysis.v1' || p.project_id !== book.project.project_id || p.chapter !== chapter.slug ||
            p.library !== category || (p.scope ?? 'chapter') !== 'chapter' || !/^[a-f0-9]{64}$/u.test(p.fingerprint)) throw new Error('报告身份或快照摘要无效。')
        makeSnapshot ??= analysisSnapshots(book,readDecision)
        snapshot ??= makeSnapshot(chapter)
        const source = chapter.title+' · '+category
        const current = p.fingerprint === snapshot.fingerprint
        if (!current && p.source_fingerprint !== snapshot.sourceFingerprint) { warn({source,reason:'analysis-stale'}); continue }
        const entries = verifyReport(p,snapshot,category,!current)
        if (!current) { warn({source,reason:'analysis-canon'}); continue }
        for (const entry of entries) {
          const row = {id:'analysis:'+chapter.id+':'+category+':'+entry.key,summary:entry.analysis,
            evidence:{state:'analysis',document:chapter.title+' · 章节分析',document_id:chapter.id,version:chapter.active_version_number,quotes:entry.quotes}}
          if (category === 'CharacterArc') add('characters',{...row,name:entry.label,role:'章节人物分析'})
          else add('events',{...row,label:entry.label,planned:entry.quotes.every(q => q.kind === 'selected-plan')})
        }
      } catch (error) {
        if (error instanceof RangeError) throw error
        issues.push(chapter.title+' · '+category+'：'+error.message)
      }
    }
  }
}
