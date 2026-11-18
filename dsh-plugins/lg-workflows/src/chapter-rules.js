function check(review, path, document, version, token, rules) {
  if (!review?.check) throw new Error('请启用支持正文规则检查的 lg-review。')
  return review.check(path, {document,version,token}, rules)
}

function requirement(item) {
  if (item.kind === 'han-range') return `汉字数在 ${item.min}–${item.max} 之间`
  const label = {required:'必含词', forbidden:'禁用词', ending:'精确结尾'}[item.kind]
  return label + ' ' + JSON.stringify(item.term)
}

export function freezeRules(review, path, source, rules) {
  const result = check(review,path,source.document,source.version,source.token,rules)
  if (!result.checks.length) throw new Error('请至少填写一项整章规则。')
  return {rules:result.rules, instruction:result.checks.map(requirement).join('\n')}
}

export function candidateChecks(review, path, state) {
  const step = state.steps.findLast(item => item.result?.candidate)
  if (!state.definition.rules || !step) throw new Error('本流程尚无可按冻结规则检查的候选。')
  return check(review,path,step.task.document,step.result.candidate.version,step.task.token,state.definition.rules)
}

export function repairTask(review, path, state, body, feedback,base=state.definition.task) {
  const result = candidateChecks(review,path,state), selected = feedback.checks
  if (feedback.version !== result.target.version || !Array.isArray(selected) || !selected.length ||
      new Set(selected).size !== selected.length || selected.some(i => !Number.isSafeInteger(i) || result.checks[i]?.passed !== false)) {
    throw new Error('请从这一版候选中勾选未通过的规则。')
  }
  const request = state.definition.authorRequest + '\n仅修正以下规则\n' + selected.map(i => requirement(result.checks[i])).join('\n')
  const keep = result.checks.filter(item => item.passed).map(requirement)
  const length = selected.map(i => result.checks[i]).find(item => item.kind === 'han-range')
  const guidance = []
  if (length) {
    const change = length.actual < length.min ? `至少增加 ${length.min-length.actual}` : `至少减少 ${length.actual-length.max}`
    guidance.push(`当前 ${length.actual} 个汉字，${change} 个汉字。计数只含汉字。用当前场景的动作和对白调整篇幅。`)
  }
  if (keep.length) guidance.push('保留已通过的规则：\n'+keep.join('\n'))
  return {...base,task:'polish',role:'manuscript-editor',version:result.target.version,start:0,end:body.selected.content.length,
    request,...(guidance.length ? {requirements:guidance.join('\n')} : {})}
}
