import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateAnalysis } from '../../dsh-plugins/lg-literary-team/src/analysis.js'
export const inject = ['agents', 'sessions', 'subagents']
export function apply(ctx) {
  void (async () => {
    await ctx.get('loader').await()
    const run = process.env.LG_LAB_RUN
    const handle = await ctx.agents.create({ sessionId: 'lg-analysis-' + randomUUID(), meta: { cwd: process.cwd() }, agentOptions: { provider: 'lg-validation', model: 'glm-4.5-air', reasoningEffort: 'off' } })
    ctx.effect(() => () => handle.dispose())
    if (process.env.LG_LAB_MODE === 'read-check') {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '这是读章工具的定点测试，不创建团队。请只调用一次 lg_read_chapter，chapter 为 1，然后用中文给出从实际正文获知的一条事实，附段落号与逐字引文。不要调用其他工具。' }] }))
      await handle.agent.whenIdle()
      const trace = readFileSync(join(run, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const reads = trace.filter(e => e.event === 'tool-result' && e.name === 'lg_read_chapter')
      const final = trace.filter(e => e.event === 'response' && e.text).at(-1)?.text
      if (reads.length !== 1 || reads[0].isError || reads[0].args.chapter !== 1 || !final) throw Error('Read-check failed')
      writeFileSync(join(run, 'summary.txt'), final, { flag: 'wx' })
      writeFileSync(join(run, 'result.json'), JSON.stringify({ passed: true, kind: 'read-check-only', requests: trace.filter(e => e.event === 'request').length, validChapterArgument: true }))
      ctx.get('appExit')(0)
      return
    }
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '现在执行一次文学分析实验。请用预设的一名分析成员分析第1章，梳理罗兰当前处境、人物认知和后续写作应遵守的约束；不要续写，不查后文。完成后向我汇总候选发现、推测和未知。已授权立即执行。' }] }))
    // The harness owns child settlement and wakes the parent. The driver sends no follow-up.
    await handle.agent.whenIdle()
    while (await ctx.subagents.waitForTreeWork(handle.agent)) await handle.agent.whenIdle()
    await handle.agent.whenIdle()
    const file = join(process.cwd(), '.agent-teams/literary-analysis/team.json')
    if (!existsSync(file)) throw Error('Main agent did not delegate')
    const team = JSON.parse(readFileSync(file, 'utf8'))
    if (team.members.length !== 1 || team.tasks.length !== 1 || team.tasks[0].status !== 'completed') throw Error('Analysis task did not complete')
    const snapshot = JSON.parse(readFileSync(process.env.LG_LAB_SNAPSHOT, 'utf8'))
    const candidate = validateAnalysis(team.tasks[0].output, snapshot)
    writeFileSync(join(run, 'candidate.json'), JSON.stringify(candidate, null, 2), { flag: 'wx' })
    const trace = readFileSync(join(run, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const mainRequests = trace.filter(e => e.event === 'request' && e.input.sessionId === handle.agent.id)
    const reported = mainRequests.some(e => JSON.stringify(e.input.messages).includes('lg.analysis-candidate.v1'))
    if (!reported) throw Error('Main agent did not receive the candidate report')
    const final = trace.filter(e => e.event === 'response' && e.sessionId === handle.agent.id && e.text).at(-1)?.text
    if (!final) throw Error('Main agent did not summarize')
    writeFileSync(join(run, 'summary.txt'), final, { flag: 'wx' })
    await ctx.sessions.flush(handle.agent.session)
    writeFileSync(join(run, 'result.json'), JSON.stringify({ passed: true, captain: handle.agent.id, member: team.members[0].id, requests: trace.filter(e => e.event === 'request').length, findings: candidate.findings.length, reportedToCaptain: reported, canonicalWrites: 0 }, null, 2))
    ctx.get('appExit')(0)
  })().catch(error => { process.stderr.write(String(error) + '\n'); ctx.get('appExit')(1) })
}
