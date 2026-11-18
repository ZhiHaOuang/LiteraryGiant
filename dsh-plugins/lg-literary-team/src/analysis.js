import { createHash } from 'node:crypto'

/** Immutable, chapter-limited input. No path supplied by the model is read. */
export function validateSnapshot(value) {
  if (value?.schema !== 'lg.analysis-input.v1' || typeof value.bookId !== 'string'
    || !Number.isSafeInteger(value.chapter) || value.chapter < 1 || typeof value.version !== 'string'
    || !Array.isArray(value.paragraphs) || value.paragraphs.length === 0
    || value.paragraphs.some(p => typeof p !== 'string' || !p.trim())) throw Error('无效章节快照')
  const hash = createHash('sha256').update(JSON.stringify(value.paragraphs)).digest('hex')
  if (value.sha256 !== hash) throw Error('章节快照校验失败')
  return value
}

/** Evidence existence is checked mechanically; literary interpretation still needs review. */
export function validateAnalysis(output, snapshot) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 16000) throw Error('报告必须是 16 KB 以内的 JSON 字符串')
  let value
  try { value = JSON.parse(output) } catch { throw Error('报告必须是合法 JSON，不加 Markdown 围栏') }
  if (value?.schema !== 'lg.analysis-candidate.v1' || value.status !== 'candidate'
    || value.bookId !== snapshot.bookId || value.chapter !== snapshot.chapter
    || value.version !== snapshot.version || value.sha256 !== snapshot.sha256) throw Error('报告来源、版本或候选状态不匹配')
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 1000
    || !Array.isArray(value.findings) || value.findings.length < 1 || value.findings.length > 8
    || !Array.isArray(value.unknowns) || value.unknowns.length > 8
    || value.unknowns.some(s => typeof s !== 'string' || s.length > 400)) throw Error('报告结构或长度不符合要求')
  for (const item of value.findings) {
    if (!['observation', 'inference'].includes(item?.kind) || typeof item.claim !== 'string'
      || !item.claim.trim() || item.claim.length > 500 || !Array.isArray(item.evidence)
      || item.evidence.length < 1 || item.evidence.length > 3) throw Error('每条判断需要类型、结论和原文证据')
    for (const ref of item.evidence) {
      if (!Number.isSafeInteger(ref?.paragraph) || ref.paragraph < 1 || ref.paragraph > snapshot.paragraphs.length
        || typeof ref.quote !== 'string' || ref.quote.length < 4 || ref.quote.length > 300
        || !snapshot.paragraphs[ref.paragraph - 1].includes(ref.quote)) throw Error('引文不在指定章节段落中')
    }
  }
  return value
}

export const ANALYSIS_INSTRUCTIONS = `你是文学分析成员。只分析提供的章节快照，不使用你对作品后文的记忆，不创作或修改正文。
先领取任务，按任务给定的 attempt_id 标记 in_progress，再用 lg_read_chapter 读取正文。把明确叙述与解释性推测分开，至少列出一个目前未知之处；不把人物相信的事直接当成世界事实。
完成时用 agent_teams_update_task，沿用任务给定的 task_id 和 attempt_id，status=completed。
output 是 JSON 字符串：{schema:"lg.analysis-candidate.v1",status:"candidate",bookId,chapter,version,sha256,summary,findings:[{kind:"observation"或"inference",claim,evidence:[{paragraph:段落序号,quote:逐字原文}]}],unknowns:[字符串]}。
bookId、chapter、version、sha256 必须照抄读取结果。输出 3—5 条最有用的判断，每条引用 1—2 段；不要重复摘抄全文。
提交成功后用 agent_teams_send_message 向 captain 回报，附 source_task_id 和 source_attempt_id，然后结束本轮。候选分析等待作者判断，不代表正式设定。`
