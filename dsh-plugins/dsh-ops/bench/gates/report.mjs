const pct = value => (value * 100).toFixed(3) + '%'
export function formatReport(report) {
  const lines = ['# OPS 0.4 benchmark evidence', '', `Platform: ${report.platform}-${report.arch}; host ${report.hostVersion}; Node ${report.node}.`, '',
    'Real host AgentLoop and tool dispatch; scripted provider, no paid model calls. Byte counts cover committed tool-result text; provider requests include the final answer request.', '',
    `Selected gates passed: ${report.passed}. All five gates accepted: ${report.fullAcceptance}.`, '', '| Gate | Status |', '| --- | --- |', ...report.gates.map(gate => `| ${gate.id} | ${gate.status} |`)]
  const read = report.gates.find(gate => gate.id === 'BM-01')
  if (read?.cases) {
    if (read.acceptanceBaseline) lines.push('', 'BM-01 acceptance baseline: OPS 0.3.1. Official-reader savings are a separate, non-gating comparison.')
    lines.push('', '| Predeclared case | Candidate bytes | 0.3.1 bytes | Official bytes | Saving vs 0.3.1 | Saving vs official |', '| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const item of read.cases) lines.push(`| ${item.scenario.id}${item.scenario.primary ? ' (primary)' : ''} | ${item.rows.candidate.outputBytes} | ${item.rows.baseline.outputBytes} | ${item.rows.official.outputBytes} | ${pct(item.savings.baseline)} | ${pct(item.savings.official)} |`)
    const primary = read.cases.find(item => item.scenario.primary)
    lines.push('', '| Primary comparator | Tool-bearing rounds | All provider requests |', '| --- | ---: | ---: |',
      ...Object.entries(primary.rows).map(([name, row]) => `| ${name} | ${row.toolBearingRounds} | ${row.providerRequests} |`), '',
      `Primary lossless source-only lower bound: ${primary.lowerBound.sourceUtf8Bytes} UTF-8 bytes. Illustrative absolute path/range labels add ${primary.lowerBound.absolutePathRangeLabelsBytes} bytes. Shared-base labels may be smaller.`,
      ...Object.entries(primary.lowerBound.comparisons).map(([name, facts]) => `${name}: 40% target ${facts.targetBytes.toFixed(1)} bytes; source alone exceeds target: ${facts.sourceAloneExceedsTarget}.`))
  }
  for (const gate of report.gates) {
    if (gate.gatedMeasurement) lines.push('', `${gate.id}: gated file/discovery schema ${gate.gatedMeasurement.tokens} tokens / ${gate.gatedMeasurement.bytes} bytes; ${gate.gatedNames.join(', ')}. Bash remains resident; full-default readiness is required.`)
    if (gate.measurement) lines.push('', `${gate.id}: full default schema ${gate.measurement.tokens} tokens / ${gate.measurement.bytes} bytes; ${gate.names.join(', ')}.${gate.gatedMeasurement ? ' This total is reported separately from the approved file/discovery budget.' : ''}`, `Whole startup message JSON: ${gate.wholeStartupMessages.tokens} tokens / ${gate.wholeStartupMessages.bytes} bytes; this is separate from schema accounting.`)
    if (gate.reason || gate.error) lines.push('', `${gate.id}: ${gate.reason ?? gate.error}`)
    if (gate.gates) lines.push('', `${gate.id}: ${JSON.stringify(gate.gates)}. ${gate.scopeNote ?? ''}`)
  }
  lines.push('', 'Earlier worker/renderer-only 3×8 probe: 2256 baseline bytes, 1949 candidate bytes (13.608% reduction), modelRounds=null, hostAuthorityExercised=false. It is historical evidence, not a formal host benchmark pass. Absolute fixture paths and renderer revisions affect byte counts.', '', 'The JSON artifact retains exact inputs, fixture hashes, canonical results, model-visible text, request schemas and comparison provenance. No universal savings or model-quality claim is made.', '')
  return lines.join('\n')
}
