import { hash } from './store.js'

export const sequenceSchema = 'lg.scene-sequence.v1'

function draftTask(path, definition, scene, token, previous) {
  let context = definition.context
  if (previous && definition.carryPrevious) {
    const documents = [...new Set([previous, ...(context?.documents ?? [])])]
    context = { ...context, documents }
  }
  return { task:'draft-scene', path, role:definition.role, request:definition.request,
    document:scene.id, version:scene.active_version_id, token,
    ...(context ? {context} : {}), references:definition.references }
}

export function sceneSequence(books, agents, path, input, limits) {
  const ids = input.scenes
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > limits.maxCalls ||
      ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new Error('请选择同章内 2–6 个不同场景，数量不能超过调用上限。')
  }
  const chapter = books.manuscript(path, input.source?.document, input.source?.version)
  if (chapter.document.kind !== 'chapter' || chapter.token !== input.source.token ||
      chapter.selected.id !== input.source.version || chapter.selected.id !== chapter.document.activeVersion) throw new Error('请刷新并选择章节当前版本。')
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 2000) throw new Error('起草要求为 1–2000 字。')
  const carryPrevious = input.carryPrevious ?? true
  if (typeof carryPrevious !== 'boolean' || carryPrevious && input.context?.audience && input.context.audience !== 'author') {
    throw new Error('引用前场正文需要作者视角。如需限定人物或读者视角，请取消引用。')
  }
  const documents = input.context?.documents
  if (carryPrevious && Array.isArray(documents) && ids.slice(0,-1).some(id => new Set([...documents,id]).size > 8)) {
    throw new Error('引用前场正文后会超过 8 份上下文文档。请减少所选资料，或取消前场引用。')
  }
  const value = { schema:sequenceSchema, chapter:chapter.document.id, parts:chapter.parts, scenes:[],
    role:input.role ?? 'chapter-writer', request:input.request, context:input.context ?? null,
    references:input.references ?? [], carryPrevious, limits }
  let first
  for (const id of ids) {
    const part = chapter.parts.find(part => part.id === id && part.kind === 'scene')
    if (!part) throw new Error('场景不属于当前章节。')
    const plan = agents.preview(draftTask(path, value, part, chapter.token))
    if (!first) first = plan
    value.scenes.push({id, title:part.title, approval:plan.draft.token})
  }
  if (Math.round(first.reservedCny * 1e6) > limits.maxReservedMicros) throw new Error('首场预留超过工作流预算。')
  value.firstSignature = first.signature
  value.provider = first.provider
  value.model = first.model
  return { definition:value, plan:first, token:hash({path,value}) }
}

export function followsCandidate(books, path, document, current, original) {
  return books.readState(path, db => {
    const version = db.prepare('SELECT metadata_json FROM document_versions WHERE document_id=? AND id=?')
    for (let depth = 0; depth <= 32; depth++) {
      if (current === original) return true
      const row = version.get(document,current)
      if (!row) break
      const metadata = JSON.parse(row.metadata_json)
      if (metadata.schema !== 'lg.candidate.v1' || !Number.isSafeInteger(metadata.source_version_id) || metadata.source_version_id >= current) break
      current = metadata.source_version_id
    }
    return false
  })
}

export function nextScene(books, agents, path, state) {
  const value = state.definition, scene = value.scenes[state.steps.length]
  if (!scene) throw new Error('已完成所选场景的起草。')
  const expected = value.parts.map(part => ({...part}))
  let previous
  for (const step of state.steps) {
    if (hash(expected) !== step.task.token) throw new Error('先前步骤使用的章节快照已变化，请复核已起草场景。')
    const version = step.result?.candidate?.version
    if (!version) throw new Error('前一场还没有可审阅的候选。')
    const body = books.manuscript(path, step.task.document, version)
    if (hash(body.selected.content) !== step.result.contentHash) throw new Error('已登记的场景候选内容发生变化。')
    if (body.selected.state === 'rejected') continue
    if (!['accepted','final'].includes(body.document.state) || !followsCandidate(books,path,body.document.id,body.document.activeVersion,version)) {
      throw new Error('请先采用或拒绝前场候选，再起草下一场。')
    }
    const part = expected.find(part => part.id === step.task.document)
    Object.assign(part, {active_version_id:body.document.activeVersion, state:body.document.state, sha256:hash(body.document.content)})
    previous = part.id
  }
  const current = books.manuscript(path, value.chapter)
  if (hash(current.parts) !== hash(expected)) throw new Error('章节顺序、正文或其他场景已变化，请复核后新建流程。')
  const part = current.parts.find(part => part.id === scene.id)
  const task = draftTask(path, value, part, current.token, previous)
  const plan = agents.preview(task)
  if (plan.draft.token !== scene.approval || plan.provider !== value.provider || plan.model !== value.model ||
      !state.steps.length && plan.signature !== value.firstSignature) throw new Error('已批准计划、首步输入或模型发生变化，请重新预览流程。')
  if (previous && value.carryPrevious && !plan.context.receipt.sources.some(s => s.kind === 'document' && s.id === previous)) {
    throw new Error('前场正文未进入上下文，请核对上下文预算。')
  }
  return { task,plan }
}

// A crash can leave a saved candidate (even an adopted one) ahead of the workflow record.
export function savedDraftResult(books, path, task, call) {
  const candidate = books.readState(path, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lg_plugin_operations'").get()) return null
    const row = db.prepare('SELECT result FROM lg_plugin_operations WHERE id=?').get(task.operation+'-candidate')
    return row && JSON.parse(row.result)
  })
  if (!candidate) return null
  if (candidate.document !== task.document || candidate.action !== 'candidate') throw new Error('已保存的候选收据与目标文档不一致。')
  const body = books.manuscript(path,task.document,candidate.version), proof = body.selected.metadata.generation
  if (proof?.signature !== task.signature || proof.run !== task.operation || proof.source.version !== task.version || proof.task !== task.task) throw new Error('已保存候选的生成来源与原调用不一致。')
  return { status:'candidate-ready',run:call,candidate,output:task.task==='draft-scene'?{content:body.selected.content}:{replacement:body.selected.content} }
}
