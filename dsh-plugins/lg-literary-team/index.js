import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { validateSnapshot, validateAnalysis, ANALYSIS_INSTRUCTIONS } from './src/analysis.js'

export const name = 'lg-literary-team'
export const inject = ['tools', 'systemPrompt', 'agents', 'subagents']
export const Config = z.object({ snapshotPath: z.string().required() })
const captainTools = ['agent_teams_create', 'agent_teams_status', 'lg_read_chapter', 'lg_read_analysis']
const memberTools = ['agent_teams_send_message', 'agent_teams_claim_task', 'agent_teams_update_task', 'agent_teams_status', 'lg_read_chapter']

/** Opt-in single-book analysis composition, independent of the old LG agent modules and UI. */
export function apply(ctx, config) {
  if (typeof ctx.subagents.deliverHostMessage !== 'function') throw Error('需要 LG 已适配的 DSH 成员投递接口')
  if (statSync(config.snapshotPath).size > 128000) throw Error('章节快照超过 128 KB')
  const snapshot = validateSnapshot(JSON.parse(readFileSync(config.snapshotPath, 'utf8')))
  ctx.tools.register({
    name: 'lg_read_chapter', description: `读取本次分析允许的第 ${snapshot.chapter} 章快照，返回版本、校验值和段落。`,
    parameters: { type: 'object', properties: { chapter: { type: 'integer', description: '本任务指定的章节号。' } }, required: ['chapter'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.chapter !== snapshot.chapter) throw Error('本任务不允许读取该章节')
      return { ...snapshot, paragraphs: snapshot.paragraphs.map((text, i) => ({ paragraph: i + 1, text })) }
    },
  })
  ctx.tools.register({
    name: 'lg_read_analysis', description: '读取当前团队已完成的完整文学分析候选，保留章节版本与全部证据；未完成则结束本轮等待自动通知。', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const agent = exec.agent
      if (!agent || agent.session.header.parentSession) throw Error('只有本任务主 Agent 可以读取汇总')
      const file = join(agent.session.header.cwd, '.agent-teams/literary-analysis/team.json')
      if (statSync(file).size > 256000) throw Error('团队记录超出本轮范围')
      const team = JSON.parse(readFileSync(file, 'utf8'))
      if (team.captainSessionId !== agent.id || team.tasks.length !== 1) throw Error('团队与当前任务不匹配')
      if (['failed', 'cancelled'].includes(team.tasks[0].status)) return { status: team.tasks[0].status, message: team.tasks[0].output ?? '任务未完成，请向作者说明。' }
      if (team.tasks[0].status !== 'completed') return { status: 'pending', message: '分析进行中，本轮结束；完成后会自动通知。' }
      return validateAnalysis(team.tasks[0].output, snapshot)
    },
  })
  const disposers = new Map()
  const attach = agent => {
    if (disposers.has(agent)) return
    const member = Boolean(agent.session.header.parentSession)
    const releaseTools = agent.ctx.tools.restrict({ allow: member ? memberTools : captainTools })
    const releasePrompt = agent.ctx.systemPrompt.section({
      name: 'lg:literary-analysis', order: 200, interpolate: false, complete: true,
      text: member ? ANALYSIS_INSTRUCTIONS : `你是作者的文学协作助手。简单问题直接回答，不必创建团队。
需要委派本章分析时，调用 agent_teams_create({name:"literary-analysis",profile:"literary-analysis-v1",approval:"automatic",description:作者目标})。
作者已授权本轮只读分析。该配置只有一名分析成员和一项任务，不要重复创建，不添加人物扮演者。
任务派发后简短说明并结束等待，成员完成会自动通知你。收到报告后用 lg_read_analysis 读取完整结果，再指出有价值的发现、推测和未知，保留段落来源；不要再重复安排相同工作。
只能读取第 ${snapshot.chapter} 章。可用工具受执行器限制。所有结果都是候选，不能修改正文或正式设定。`,
    })
    disposers.set(agent, () => { releasePrompt(); releaseTools() })
  }
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => { disposers.get(agent)?.(); disposers.delete(agent) })
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.effect(() => () => { for (const release of disposers.values()) release(); disposers.clear() })
  ctx.tools.guard(exec => {
    const member = Boolean(exec.agent?.session.header.parentSession)
    if (!exec.agent || !(member ? memberTools : captainTools).includes(exec.name)) return '文学分析任务未授予此工具权限'
    const args = exec.arguments
    if (exec.name === 'agent_teams_create' && (args.profile !== 'literary-analysis-v1' || args.name !== 'literary-analysis'
      || args.approval !== 'automatic' || args.plan !== undefined)) return '本轮只能使用预设的单成员分析团队'
    if (exec.name === 'agent_teams_send_message' && args.to !== 'captain') return '分析成员只能向主 Agent 回报'
    if (exec.name === 'lg_read_chapter' && args.chapter !== snapshot.chapter) return '本任务不允许读取该章节'
    if (exec.name === 'agent_teams_update_task' && args.status === 'completed') {
      try { validateAnalysis(args.output, snapshot) } catch (error) { return error.message }
    }
    return undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (!result.isError && !exec.agent?.session.header.parentSession
      && (exec.name === 'agent_teams_create' || (exec.name === 'lg_read_analysis' && result.value?.status === 'pending'))) {
      return { ...result, concludesTurn: true }
    }
    return result
  })
}
