import {realpathSync} from 'node:fs'
import {createBookManagement} from './src/book-management.js'
import {createShelf,prepareDirectories} from './src/bookshelf.js'
import z from '@deepseek-ai/schemastery'
import {oldRuns,legacyRun,verifyOldVersion} from './src/legacy-runs.js'
import { describeBook, openBook, readBook } from './src/read.js'
import { renameBook } from './src/book-title.js'
import { ensurePolicy } from './src/supervision-policy.js'
import { readManuscript,document,version,chapterSnapshot } from './src/manuscript.js'
import {candidateLineage} from './src/legacy-chapter.js'
import {compactFingerprint} from './src/analysis-snapshot.js'
import { storyIndex } from './src/story-index.js'
import { queueStructureMirror, mirrorReceipt } from './src/mirror-queue.js'
import { chapterFile, retryChapterMirror } from './src/chapter-files.js'
import { writeManuscript, previewAcceptance, adjudicateAcceptance } from './src/write.js'
import { accessState } from './src/state.js'
import { previewCreation, initializeBook, integrity } from './src/initialize.js'
import { wordCount } from './src/summary.js'
import { createDocuments } from './src/documents.js'
import { pendingVersions } from './src/pending-versions.js'
import {candidateAnalysis} from './src/candidate-analysis.js'
import {latestPublication,retryAnalyses} from './src/analysis-publication.js'
import {timelineView} from './src/story-data/temporal.js'
import {storyRecordHistory} from './src/story-data/store.js'
import {readStoryPage,readStoryTimeline,readStoryOverview} from './src/story-data/read-model.js'

export const inject = ['configEditor']
export const Config = z.object({ projects: z.array(z.string()).default([]), archivedProjects:z.array(z.string()).default([]), removedProjects:z.array(z.string()).default([]), shelvedWorkspaces:z.array(z.object({path:z.string(),title:z.string(),sessionIds:z.array(z.string())})).default([]), rootDirectory: z.string().default(''), booksDirectory:z.string().default(''), libraryDirectory:z.string().default('') })

export function apply(ctx, config) {
  const persist=async update=>{
    if(!ctx.fiber.entry)throw Error('当前宿主不支持保存插件配置。')
    let saved
    await ctx.configEditor.edit(ctx.fiber.entry,current=>(saved=update(current)))
    shelf.setCatalog(saved)
  }
  const shelf=createShelf(config,()=>ctx.get('workspaceRegistry'),persist)
  const management=createBookManagement(shelf,persist)
  ctx.inject(['workspaceRegistry'],scope=>{scope.effect(()=>{void shelf.sync().catch(()=>{});return ()=>{}},'lg-books: load book workspaces')})
  const registered = path => {
    path=realpathSync(path)
    if (!shelf.list({includeArchived:true}).some(book=>!book.error&&book.path===path)) throw new Error('请先在控制台添加此作品。')
    return path
  }
  const verifyGeneration = (path, generation) => {
    if (generation.references?.length) {
      const library = ctx.get('literaryLibrary')
      if (!library) throw new Error('请先启用 lg-library，校验候选引用来源。')
      for (const source of generation.references) {
        if (library.read(path, source.citation).sha256 !== source.sha256) throw new Error('候选参考资料已变化，请重新生成。')
      }
    }
    if (generation.context) {
      const context = ctx.get('literaryContext')
      if (!context) throw new Error('请先启用 lg-context，校验候选文学上下文。')
      context.verify(path, generation.context)
    }
  }
  const books = {
    storyTimeProjection:records=>timelineView(records),
    storyTime:(path,options)=>readStoryTimeline(registered(path),options),
    storyData:(path,options)=>readStoryPage(registered(path),options),
    storyOverview:(path,options)=>readStoryOverview(registered(path),options),
    storyDataHistory:(path,id)=>storyRecordHistory(registered(path),id),
    legacyRuns:(path,before)=>oldRuns(registered(path),before),
    legacyRun:(path,id)=>legacyRun(registered(path),id),
    verifyOldVersion:(path,ref)=>accessState(registered(path),false,db=>verifyOldVersion(db,ref)),
    candidateAnalysis:(path,target,save)=>candidateAnalysis(registered(path),target,ctx.get('literaryPlanning')?.readDecisionInTransaction,save),
    wordCount,
    chapterMirrors: {
      queue: queueStructureMirror,
      status(db, ref) { return mirrorReceipt(db,ref.chapter,ref.operation) },
      finish(path, ref) {
        try { return retryChapterMirror(registered(path),ref.chapter,ref.operation) }
        catch (error) { return {...ref,action:'structure-mirror',sync:'mirror-pending',syncError:error.message} }
      },
    },
    readState(path, callback) { return accessState(registered(path), false, callback) },
    changeState(path, callback) { return accessState(registered(path), true, callback) },
    list: shelf.list,
    libraryRoot() { const state=shelf.snapshot();if(state.error)throw Error(state.error);return state.libraryPath || '' },
    shelf: shelf.sync,
    async configureDirectories(input) {
      if(!ctx.fiber.entry)throw Error('当前宿主不支持保存插件配置。')
      const selected=prepareDirectories(input)
      await ctx.configEditor.edit(ctx.fiber.entry,current=>({...current,...selected,rootDirectory:''}))
      shelf.setDirectories(selected)
      return shelf.sync()
    },
    async rename(path,input) {
      const renamed=renameBook(registered(path),input)
      const workspace=ctx.get('workspaceRegistry')?.list().find(w=>w.path===renamed.path)
      if(workspace && workspace.title!==renamed.name) {
        try { await workspace.setTitle(renamed.name) }
        catch { throw Error('书名已保存，侧栏同步失败。请重试。') }
      }
      return renamed
    },
    snapshot(path) {
      return readBook(registered(path))
    },
    manuscript(path, document, version) { return readManuscript(registered(path), document, version) },
    legacyCandidateProof(path,id,versionId,token){
      return books.readState(path,db=>{
        const doc=document(db,id),v=version(db,id,versionId)
        if(v.state!=='candidate'||chapterSnapshot(db,doc).token!==token)throw new Error('旧候选或章快照已变化。')
        const {legacy}=candidateLineage(db,doc,v,token,ctx.get('literaryPlanning')?.readDecisionInTransaction)
        if(!legacy)throw new Error('未找到旧候选依据。')
        return compactFingerprint(legacy)
      })
    },
    candidate(path, input, generation) { return writeManuscript(registered(path), { ...input, action: 'candidate' }, generation,null,null,null,null,ctx.get('literaryPlanning')?.readDecisionInTransaction) },
    add:management.add,
    manage:management.change,
  }
  books.documents = createDocuments(books, verifyGeneration)
  ctx.effect(() => ctx.provide('literaryBooks', books), 'lg-books: service')
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({
    path: '/api/lg/books', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json()
        if (!input || typeof input !== 'object') throw new Error('请求格式错误。')
        let value
        if (input.action === 'shelf') value = await books.shelf()
        else if (input.action === 'configure-directories') value = await books.configureDirectories(input)
        else if (input.action === 'list') value = books.list()
        else if (input.action === 'rename') value = await books.rename(input.path,input)
        else if (input.action === 'read') value = books.snapshot(input.path)
        else if (input.action === 'story-time') value = books.storyTime(input.path,input.options)
        else if (input.action === 'story-data') value = books.storyData(input.path,input.options)
        else if (input.action === 'story-overview') value = books.storyOverview(input.path,input.options)
        else if (input.action === 'story-data-history') value = books.storyDataHistory(input.path,input.id)
        else if (input.action === 'enable-supervision') {
          const book = openBook(registered(input.path), {write:true})
          try {
            if (input.confirmed !== true || input.projectId !== book.project.project_id)
              throw new Error('请核对作品并确认启用章节监督。')
            book.verify()
            value = {categories:ensurePolicy(book).chapter_categories}
          } finally { book.close() }
        }
        else if (input.action === 'create-preview') value = previewCreation(input.path, input.name)
        else if (input.action === 'create') {
          if (!ctx.fiber.entry) throw new Error('当前宿主不支持保存插件配置。')
          value = await books.add(initializeBook(input).path)
        }
        else if (input.action === 'integrity') value = integrity(registered(input.path))
        else if (input.action === 'add') value = await books.add(input.path)
        else if (['archive','restore','remove'].includes(input.action)) value=await books.manage(input)
        else if (input.action === 'chapter-file-retry') value = retryChapterMirror(registered(input.path),input.document,input.operation)
        else if (['chapter-file-preview','chapter-file-apply'].includes(input.action)) value = chapterFile(registered(input.path), input)
        else if (input.action === 'story-index') value = storyIndex(registered(input.path), undefined, ctx.get('literaryPlanning')?.readDecisionInTransaction)
        else if (input.action === 'story-index-save') value = storyIndex(registered(input.path), input.token ?? null, ctx.get('literaryPlanning')?.readDecisionInTransaction)
        else if (input.action === 'manuscript') value = books.manuscript(input.path, input.document, input.version)
        else if (input.action === 'pending-versions') value = books.readState(input.path, db=>pendingVersions(db,input.chapter,input.before))
        else if (input.action==='analysis-publication') value=books.readState(input.path,db=>latestPublication(db,input.document))
        else if (input.action==='analysis-publication-retry') value=retryAnalyses(registered(input.path),input.document,input.operation,ctx.get('literaryPlanning')?.readDecisionInTransaction)
        else if (['edit', 'candidate', 'accept', 'reject','acceptance-review','adjudicate-supervision'].includes(input.action)) {
          const write=({'acceptance-review':previewAcceptance,'adjudicate-supervision':adjudicateAcceptance})[input.action]??writeManuscript
          value = write(registered(input.path), input, null,
            references => verifyGeneration(input.path, { references }),
            context => verifyGeneration(input.path, { context }), draft => {
              const planning = ctx.get('literaryPlanning')
              if (!planning) throw new Error('请启用 lg-planning 校验起草计划。')
              planning.verifyDraft(input.path, draft)
            }, feedback => {
              const review = ctx.get('literaryReview')
              if (!review) throw new Error('请启用 lg-review 校验改稿审阅依据。')
              review.verifyFeedback(input.path, feedback)
            },ctx.get('literaryPlanning')?.readDecisionInTransaction)
        }
        else throw new Error('未知作品操作。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 400 })
      }
    },
  }), 'lg-books: author API')
  })
  ctx.inject(['connection'], scope => {
  scope.effect(() => scope.connection.fetch.register({
    path: '/api/lg/documents', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const input = await request.json(), service = books.documents
        let value
        if (input?.action === 'list') value = service.list(input.path, input.options)
        else if (input?.action === 'read') value = service.read(input.path, input.id, input.version)
        else if (input?.action === 'preview') value = service.preview(input.path, input.change)
        else if (input?.action === 'apply') value = service.apply(input.path, input.change, input.token, input.operation)
        else throw new Error('未知资料操作。')
        return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }) }
    },
  }), 'lg-books: documents API')
  })
}

