import {estimateMessage, estimateToolsTotal, estimateSystemContent} from './context-pricing.js'

const categories = ['system', 'schemas', 'user', 'developer', 'skill', 'assistant', 'tool', 'other']
const counters = () => Object.fromEntries(categories.map(key => [key, 0]))
const blocksOf = value => Array.isArray(value) ? value : typeof value === 'string' && value ? [{type:'text', text:value}] : []
const estimate = fn => {try {const n=fn();return Number.isFinite(n)&&n>=0?n:0} catch {return 0}}
const names = () => {
  const seen = new Set()
  return {
    add(value) {
      if (typeof value !== 'string' || seen.size >= 64) return
      const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160)
      if (name) seen.add(name)
    },
    values: () => [...seen],
  }
}

function categoryOf(message) {
  // Match dsh-context's initial role/source precedence; skill results are handled below.
  if (message.role === 'assistant') return 'assistant'
  if (message.role === 'tool') return 'tool'
  if (message.role === 'developer') return 'developer'
  if (message.role !== 'user') return 'other'
  const source = message.source
  if (source?.kind === 'skill-invocation' || source?.kind === 'skill-catalog') return 'skill'
  if ((typeof source?.kind === 'string' && source.kind !== '' && source.kind !== 'user')
    || typeof source?.form === 'string') return 'developer'
  return 'user'
}

/** Numeric context estimates, never provider usage or stored prompt/response text. */
export function captureContext(options = {}) {
  const tokens = counters(), items = counters(), tools = names(), skills = names()
  const declarations = Array.isArray(options?.tools) ? options.tools : []
  tokens.schemas = estimate(() => estimateToolsTotal(declarations))
  items.schemas = declarations.length
  for (const tool of declarations) tools.add(tool?.name)
  const prefix = blocksOf(options?.system)
  if (prefix.length) {
    tokens.system = estimate(() => estimateSystemContent(prefix))
    items.system++
  }
  const callNames = new Map()
  for (const message of Array.isArray(options?.messages) ? options.messages : []) {
    if (!message || typeof message !== 'object') continue
    const content = blocksOf(message.content)
    let loadedSkill = ''
    if (message.role === 'tool') {
      const tool = callNames.get(message.toolCallId ?? message.source?.callId)
      if (tool === 'skill' || tool === undefined) {
        const text = content.find(block => block?.type === 'text' && typeof block.text === 'string' && block.text !== '')?.text ?? ''
        loadedSkill = text.match(/<skill_content\s+name="([^"]+)"/)?.[1] ?? ''
      }
    }
    // fold.ts reclassifies loaded skill content after its initial tool-role classification.
    const category = message.role === 'system' ? 'system' : loadedSkill ? 'skill' : categoryOf(message)
    tokens[category] += estimate(() => category === 'system'
      ? estimateSystemContent(content)
      : estimateMessage({content}, message.role === 'assistant' || message.role === 'developer'))
    items[category]++
    if (category === 'skill') {
      skills.add(loadedSkill)
      skills.add(message.source?.name)
      if (Array.isArray(message.source?.sections)) {
        for (const section of message.source.sections) skills.add(section?.name)
      }
    }
    if (message.role === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool-call' && typeof block.callId === 'string' && typeof block.name === 'string') {
          callNames.set(block.callId, block.name)
        }
      }
    }
  }
  return {version:1, estimator:'dsh-context/0.82.1', tokens, items, tools:tools.values(), skills:skills.values()}
}
