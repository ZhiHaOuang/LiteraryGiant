/** Assertions about the workload's availability and controls, independent of its byte/token score. */
import { NATIVE_RESIDENT_FILE_TOOLS } from '../../lib/capabilities/registry.js'
import { publicToolName } from '../../lib/policy.js'
import { schemaMeasurement } from './metrics.mjs'
export function startupReadiness(tools, platform = process.platform) {
  const expected = [...NATIVE_RESIDENT_FILE_TOOLS, 'discover_tools', ...(platform === 'win32' ? ['bash'] : [])].map(publicToolName).sort()
  const names = tools.map(tool => tool.name), actual = new Set(names)
  const missing = expected.filter(name => !actual.has(name)), unexpected = names.filter(name => !expected.includes(name))
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  const bash = tools.find(tool => tool.name === publicToolName('bash'))
  const shellReady = platform !== 'win32' || Boolean(bash?.parameters?.required?.includes('description')
    && bash.parameters.properties?.run_in_background?.type === 'boolean')
  const reasons = []
  if (missing.length) reasons.push('missing required tools: ' + missing.join(', '))
  if (unexpected.length) reasons.push('unexpected startup tools: ' + unexpected.join(', '))
  if (duplicates.length) reasons.push('duplicate startup tools: ' + duplicates.join(', '))
  if (!shellReady) reasons.push('the full host-compatible Bash contract is unavailable')
  return { ready: !reasons.length, expected, missing, unexpected, duplicates, shellReady, reason: reasons.join('; ') || undefined }
}
/** User-approved gates: OPS 0.3.x bytes; file/discovery schemas with Bash still resident. */
export function readAcceptance(savings, toolBearingRounds) {
  return toolBearingRounds === 1 && savings.baseline >= .4 ? 'passed' : 'failed'
}
export function startupAssessment(tools, platform = process.platform) {
  const readiness = startupReadiness(tools, platform)
  const gatedTools = tools.filter(tool => tool.name !== publicToolName('bash'))
  const measurement = schemaMeasurement(tools), gatedMeasurement = schemaMeasurement(gatedTools)
  return { status: !readiness.ready ? 'blocked' : gatedMeasurement.tokens <= 400 ? 'passed' : 'failed',
    readiness, names: tools.map(tool => tool.name), measurement, gatedNames: gatedTools.map(tool => tool.name), gatedMeasurement }
}
export function readControlPassed(value, file, expectedText) {
  if (value?.status !== 'completed' || value.failed !== 0 || value.pending !== 0 || value.truncated !== false
    || !Array.isArray(value.items) || value.items.length !== 1) return false
  const item = value.items[0]
  return item?.status === 'completed' && item.path === file && item.complete === true && item.truncated === false
    && item.failed === 0 && item.items?.length === 1 && item.items[0].path === file
    && item.items[0].line === 1 && item.items[0].text === expectedText
}
export function rejectedWithoutEffects(value, code) {
  return value?.status === 'rejected' && value.error?.code === code && value.error?.effectState === 'none'
}
