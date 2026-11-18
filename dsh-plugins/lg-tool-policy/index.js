import z from '@deepseek-ai/schemastery'

export const inject = ['tools']
export const Config = z.object({
  enabled: z.boolean().default(false),
  allow: z.array(z.string().min(1)).default([]),
})

export function apply(ctx, config) {
  if (!config.enabled) return
  const restrictions = new Map()
  ctx.on('agent/created', ({ agent }) => {
    if (!restrictions.has(agent)) restrictions.set(agent, agent.ctx.get('tools').restrict({ allow: config.allow }))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    restrictions.get(agent)?.()
    restrictions.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of restrictions.values()) dispose()
    restrictions.clear()
  }, 'lg-tool-policy: release agent tool restrictions')
}
