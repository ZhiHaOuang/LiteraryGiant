export function estimateUsage(usage, config) {
  if (!usage || ![usage.inputTokens, usage.outputTokens].every(v => Number.isSafeInteger(v) && v >= 0)) return null
  const count = key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : 0
  return ((usage.inputTokens + count('cacheReadTokens') + count('cacheWriteTokens')) * config.inputCnyPerMillion
    + (usage.outputTokens + count('reasoningTokens')) * config.outputCnyPerMillion) / 1e6
}
