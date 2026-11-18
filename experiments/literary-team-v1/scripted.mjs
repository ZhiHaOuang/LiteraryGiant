import { readFileSync } from 'node:fs'

/** Keyless fixture: exercises the real loop and executor, not generation quality. */
export function response(options) {
  const messages = options.messages
  const blocks = messages.flatMap(m => m.content ?? [])
  const calls = blocks.filter(b => b.type === 'tool-call').map(b => ({ name: b.name, args: JSON.parse(b.arguments) }))
  const has = name => calls.some(c => c.name === name)
  const member = !(options.tools ?? []).some(t => t.name === 'agent_teams_create')
  const tool = (name, args) => ({ type: 'tool-call', id: 'scripted-' + (calls.length + 1), name, arguments: JSON.stringify(args) })
  if (!member) {
    if (!has('bash')) return tool('bash', { command: 'echo should-not-execute' })
    if (!has('agent_teams_create')) return tool('agent_teams_create', { name: 'literary-analysis', profile: 'literary-analysis-v1', approval: 'automatic' })
    if (JSON.stringify(messages).includes('lg.analysis-candidate.v1') && !has('lg_read_analysis')) return tool('lg_read_analysis', {})
    return { type: 'text', text: has('lg_read_analysis') ? '已收到有出处的候选分析，留待作者确认。' : '已委派，等待分析成员回报。' }
  }
  const text = JSON.stringify(messages)
  const attempt = text.match(/Attempt id: ([^\\\s"]+)/)?.[1]
  if (!attempt) throw Error('Fixture missing attempt id')
  if (!has('agent_teams_claim_task')) return tool('agent_teams_claim_task', { task_id: 't1' })
  if (!calls.some(c => c.name === 'agent_teams_update_task' && c.args.status === 'in_progress')) return tool('agent_teams_update_task', { task_id: 't1', attempt_id: attempt, status: 'in_progress' })
  if (!calls.some(c => c.name === 'lg_read_chapter' && c.args.chapter === 2)) return tool('lg_read_chapter', { chapter: 2 })
  if (!calls.some(c => c.name === 'lg_read_chapter' && c.args.chapter === 1)) return tool('lg_read_chapter', { chapter: 1 })
  const snapshot = JSON.parse(readFileSync(process.env.LG_LAB_SNAPSHOT, 'utf8'))
  const paragraph = snapshot.paragraphs.findIndex(p => p.includes('一把抓起')) + 1
  const candidate = { schema: 'lg.analysis-candidate.v1', status: 'candidate', bookId: snapshot.bookId, chapter: 1, version: snapshot.version, sha256: snapshot.sha256,
    summary: '模拟分析，仅用于机制测试。', findings: [{ kind: 'observation', claim: '罗兰推迟了审判。', evidence: [{ paragraph, quote: '困了，改天再判，今天都散了吧' }] }], unknowns: ['女巫身份与能力尚待正文提供证据。'] }
  const completions = calls.filter(c => c.name === 'agent_teams_update_task' && c.args.status === 'completed')
  if (completions.length < 2) {
    if (completions.length === 0) candidate.findings[0].evidence[0].quote = '这是原文没有的伪造引文'
    return tool('agent_teams_update_task', { task_id: 't1', attempt_id: attempt, status: 'completed', output: JSON.stringify(candidate) })
  }
  if (!has('agent_teams_send_message')) return tool('agent_teams_send_message', { to: 'captain', source_task_id: 't1', source_attempt_id: attempt, content: JSON.stringify(candidate) })
  return { type: 'text', text: '分析已完成并回报。' }
}
export async function* chunks(block) {
  yield { type: 'block-start', index: 0, blockType: block.type }
  yield block.type === 'tool-call' ? { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments } : { type: 'text-delta', index: 0, text: block.text }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}
