import { planMemory, memoryRequestHash } from './memory.js'
import { withPreferences } from './author.js'
import { planReference, referenceRequestHash } from './library.js'
import { roles, planTask, parseResult, hash } from './tasks.js'
import { planningTask, planningRequestHash, planGeneration, parsePlanning } from './planning.js'
import { planReview, reviewRequestHash, isReviewTask } from './review.js'
import { planDraft, parseDraft } from './draft.js'
import { taskReferences } from './references.js'
import {planAnalysis,resolveAnalysis,specialists} from './candidate-analysis.js'

export function createAgents(books, execution, config, library = () => undefined, context = () => undefined, planning = () => undefined, review = () => undefined, memory = () => undefined, author = () => undefined, methods = () => undefined) {
  const references = input => taskReferences(input.path, input.references, library())
  const prepareBase = (input, runner) => {
    if(input.task==='candidate-analysis')return planAnalysis(books,runner,config,input,library())
    if (input.task === 'analyze-reference') return planReference(runner, config, input, library())
    if (input.task === 'extract-memory') return planMemory(runner, config, input, memory())
    if (input.task === 'draft-scene') return planDraft(books, runner, config, input, planning(), context(), references(input))
    if (isReviewTask(input.task)) return planReview(runner, config, input, review())
    if (planningTask(input.task)) {
      if (input.feedback && !review()) throw new Error('请启用 lg-review 后使用审阅反馈。')
      const feedback = input.feedback ? review().feedback(input.path, input.feedback, input.task, input.target) : null
      return planGeneration(books, runner, config, input, planning(), context(), references(input), feedback)
    }
    let feedback = null
    if (input.feedback) {
      if (input.task !== 'polish' || !review()) throw new Error('正文反馈改稿需要 lg-review 与润色任务。')
      feedback = review().feedback(input.path, input.feedback, input.task, Object.fromEntries(['document','version','token','start','end'].map(key=>[key,input[key]])))
    }
    const options = input.context ?? feedback?.context?.options
    let material = null
    if (options != null) {
      if (!context()) throw new Error('请启用 lg-context 后使用文学上下文。')
      material = context().build(input.path, options)
    }
    return planTask(books, runner, config, input, references(input), material, feedback)
  }
  const prepare = input => {
    const material = author()?.material(input.path, input.task)
    let method
    if (input.method !== undefined) {
      if (!methods()) throw new Error('请启用 lg-skills 后使用所选文学方法。')
      method = methods().select(input.task, input.method)
    }
    const decorate = value => {
      const result = withPreferences(value, material)
      if (!method) return result
      return { ...result, system: result.system + '\n本次选用的文学方法（遵循原任务范围、作者要求和返回格式）\n' + method.title + '\n' + method.technique,
        scope: result.scope + '|literary-method:' + method.digest }
    }
    const runner = { preview: value => execution.preview(decorate(value)) }
    const plan = prepareBase(input, runner)
    return { ...plan, modelInput: decorate(plan.modelInput), ...(method ? {method} : {}), ...(material ? { authorPreferences: material } : {}) }
  }
  return {
    roles: () => roles(config, !!planning() && !!context(), !!review(), !!memory()?.extractionSnapshot, !!library()?.analysisSnapshot).map(role=>
      books.candidateAnalysis&&library()?.finalizeChapterCard&&Object.values(specialists).includes(role.id)
        ? {...role,tasks:[...role.tasks,'candidate-analysis'],enabled:config.roles.find(r=>r.id===role.id)?.enabled!==false}:role),
    analysisStatus(path,{document,version,token}){
      const status=books.candidateAnalysis(path,{document,version,token})
      return {categories:status.categories.map(({category,state,error})=>({category,state,role:specialists[category],...(error?{error}:{})}))}
    },
    methods: task => methods()?.list(task) ?? [],
    preview: prepare,
    async run(input, signal) {
      if(input.task==='candidate-analysis') {
        const prior=books.candidateAnalysis(input.path,input.target)
        if(prior.state==='current'&&prior.run===input.operation&&prior.signature===input.signature)
          return {status:'analysis-ready',run:execution.status(input.operation),report:prior.report,replayed:true}
      }
      if (input.task === 'analyze-reference') {
        if (!library()?.analysisReplay) throw new Error('请启用支持分析卡的 lg-library。')
        const previous = library().analysisReplay(input.path, input.operation, referenceRequestHash(input), input.signature)
        if (previous) return { run: execution.status(input.operation), status: 'reference-ready', card: previous, replayed: true }
      }
      if (input.task === 'extract-memory') {
        if (!memory()?.extracted) throw new Error('请启用支持正文提取的 lg-memory。')
        const previous = memory().extracted(input.path, input.operation, memoryRequestHash(input), input.signature)
        if (previous) return { run: execution.status(input.operation), status: 'memory-ready', extraction: previous, replayed: true }
      }
      if (isReviewTask(input.task)) {
        if (!review()) throw new Error('请启用 lg-review。')
        const previous = review().replay(input.path, input.operation, reviewRequestHash(input), input.signature)
        if (previous) return { run: execution.status(input.operation), status: 'review-ready', report: previous, replayed: true }
      }
      if (planningTask(input.task)) {
        if (!planning()) throw new Error('请启用 lg-planning。')
        const previous = planning().generated(input.path, input.operation + '-planning', planningRequestHash(input), input.signature)
        if (previous) return { run: execution.status(input.operation), status: 'planning-ready', proposal: previous, replayed: true }
      }
      const plan = prepare(input)
      if (input.signature !== plan.signature) throw new Error('任务输入或模型设置已变化，请重新预览。')
      const run = await execution.run(input.operation, plan.modelInput, signal)
      if (run.status !== 'succeeded') return { run, status: run.status }
      if(input.task==='candidate-analysis') {
        let report
        try {report=resolveAnalysis(run.result.text,plan.source,input.target.category,library())}
        catch(error){return {run,status:'invalid-output',validationError:error.message}}
        try {
          const result=books.candidateAnalysis(input.path,input.target,{token:plan.source.token,operation:input.operation,signature:plan.signature,report})
          if(result.run!==input.operation||result.signature!==plan.signature)throw new Error('其他报告已保存，请刷新并核对。')
          return {run,status:'analysis-ready',report:result.report}
        }catch(error){
          if(error.code==='ANALYSIS_OUTPUT_INVALID')return {run,status:'invalid-output',validationError:error.message}
          return {run,status:'analysis-pending',candidateError:error.message}
        }
      }
      if (input.task === 'analyze-reference') {
        if (!library()?.saveAnalysis) return { run, status: 'reference-pending', candidateError: '资料插件已停用；原结果保留，未保存分析卡。' }
        try { library().validateAnalysis(run.result.text, plan.source) }
        catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
        try {
          const card = library().saveAnalysis(input.path, input.operation, referenceRequestHash(input), plan.signature, plan.source, run.result.text)
          return { run, status: 'reference-ready', card }
        } catch (error) { return { run, status: 'reference-pending', candidateError: error.message + '；原结果保留，未保存分析卡。' } }
      }
      if (input.task === 'extract-memory') {
        if (!memory()?.saveExtraction) return { run, status: 'memory-pending', candidateError: '记忆插件已停用；原结果保留，未保存提案。' }
        try { memory().validateExtraction(run.result.text, plan.source) }
        catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
        try {
          const extraction = memory().saveExtraction(input.path, input.operation, memoryRequestHash(input), plan.signature, plan.source, run.result.text)
          return { run, status: 'memory-ready', extraction }
        } catch (error) { return { run, status: 'memory-pending', candidateError: error.message + '；原结果保留，未保存提案。' } }
      }
      if (input.task === 'draft-scene') {
        let output
        try { output = parseDraft(run.result.text, books, plan.wordRange) }
        catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
        try {
          if (prepare(input).signature !== plan.signature) throw new Error('起草期间正文、计划或材料发生变化。')
          const candidate = books.candidate(input.path, { document: input.document, sourceVersion: plan.source.version,
            token: input.token, content: output.content, reason: input.request, operation: input.operation + '-candidate' },
            { run: input.operation, role: plan.role, task: input.task, source: plan.source, draft: plan.draft,
              signature: plan.signature, context: plan.context.receipt, references: plan.references, notes: output.notes, ...(plan.method ? {method:plan.method} : {}), ...(plan.authorPreferences ? { authorPreferences: plan.authorPreferences } : {}) })
          return { run, status: 'candidate-ready', output, candidate }
        } catch (error) { return { run, status: 'candidate-pending', output, candidateError: error.message + '；原结果保留，未保存候选。' } }
      }
      if (isReviewTask(input.task)) {
        let output
        try { output = review().validate(run.result.text, plan.source) }
        catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
        try {
          const report = review().save(input.path, input.operation, reviewRequestHash(input), plan.signature, plan.source, output)
          return { run, status: 'review-ready', output, report }
        } catch (error) { return { run, status: 'review-pending', output, candidateError: error.message + '；原结果保留，未登记问题。' } }
      }
      if (planningTask(input.task)) {
        let output
        try { output = parsePlanning(input.task, run.result.text, plan) }
        catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
        try {
          if (prepare(input).signature !== plan.signature) throw new Error('生成期间规划目标或材料发生变化。')
          const generation = { schema: 'lg.planning-generation.v1', run: input.operation, role: plan.role, task: input.task,
            requestHash: planningRequestHash(input), signature: plan.signature, ...(plan.method ? {method:plan.method} : {}), ...(plan.authorPreferences ? { authorPreferences: plan.authorPreferences } : {}), references: plan.references, context: plan.context.receipt, ...(plan.feedback ? { feedback: plan.feedback } : {}) }
          const proposal = planning().propose(input.path, { ...plan.change, ...output }, input.operation + '-planning', generation)
          return { run, status: 'planning-ready', output, proposal }
        } catch (error) { return { run, status: 'planning-pending', output, candidateError: error.message + '；结果保留，未保存待审规划。' } }
      }
      let output
      try { output = parseResult(input.task, run.result.text, plan.source, plan.outputFormat) }
      catch (error) { return { run, status: 'invalid-output', validationError: error.message } }
      try {
        if (plan.feedback) {
          if (!review()) throw new Error('审阅服务已停用，未保存改稿。')
          review().verifyFeedback(input.path, plan.feedback)
        }
        const snapshot = books.manuscript(input.path, input.document, input.version)
        let referencesChanged = false
        try { referencesChanged = hash(references(input)) !== hash(plan.references) } catch { referencesChanged = true }
        let contextChanged = false
        try { if (plan.context) context().verify(input.path, plan.context.receipt) } catch { contextChanged = true }
        const stale = contextChanged || referencesChanged || snapshot.token !== input.token || hash(snapshot.selected.content) !== plan.source.contentDigest
        if (input.task === 'review') return { run, status: stale ? 'source-changed' : 'review-ready', output, source: plan.source, references: plan.references, stale }
        if (contextChanged) throw new Error('模型调用期间文学上下文已变化或不可用；结果保留，未写入候选。')
        if (referencesChanged) throw new Error('模型调用期间参考资料已变化或不可用；结果保留，未写入候选。')
        if (stale) throw new Error('模型调用期间正文发生变化；生成结果保留在任务记录中，未写入候选。')
        const text = snapshot.selected.content
        const candidate = books.candidate(input.path, { document: input.document, sourceVersion: snapshot.selected.id,
          token: input.token, content: text.slice(0, input.start) + output.replacement + text.slice(input.end),
          reason: input.request, operation: input.operation + '-candidate' },
          { run: input.operation, role: plan.role, task: plan.task, source: plan.source, references: plan.references,
            signature: plan.signature, format: plan.outputFormat, notes: output.notes, ...(plan.method ? {method:plan.method} : {}), ...(plan.authorPreferences ? { authorPreferences: plan.authorPreferences } : {}), ...(plan.feedback ? { feedback: plan.feedback } : {}), ...(plan.context ? { context: plan.context.receipt } : {}) })
        return { run, status: 'candidate-ready', output, candidate }
      } catch (error) { return { run, status: 'candidate-pending', output, candidateError: error.message } }
    },
    status: id => execution.status(id), cancel: id => execution.cancel(id),
  }
}
