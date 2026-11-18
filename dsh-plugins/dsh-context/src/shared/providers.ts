const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
  'claude': 'anthropic',
  'codex': 'openai',
  'fireworks': 'fireworks-ai',
  'together': 'togetherai',
  'vercel-ai-gateway': 'vercel',
  'kimi-code-plan-global': 'moonshotai',
  'kimi-code-plan-cn': 'moonshotai-cn',
  'zai-coding-plan': 'zai',
  'zhipuai-coding-plan': 'zhipuai',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
  'minimax-coding-plan': 'minimax',
  'minimax-cn-coding-plan': 'minimax-cn',
}

export function modelsDevProviderOf(dshProviderId: string): string {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

export function isDeepSeekProvider(dshProviderId: string): boolean {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}
