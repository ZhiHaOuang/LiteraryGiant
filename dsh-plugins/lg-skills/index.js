import z from '@deepseek-ai/schemastery'
import catalog from './catalog.json' with { type: 'json' }
import { listMethods, selectMethod } from './methods.js'

export const inject = ['skills']
export const Config = z.object({ modelDiscovery: z.boolean().default(false) })

export function apply(ctx, config = {}) {
  for (const method of catalog) {
    ctx.skills.register({
      name: method.name, description: method.description, provider: 'lg-skills', source: 'runtime',
      invocation: { userInvocable: true, modelInvocable: config.modelDiscovery === true },
      content: [
        '# ' + method.title, method.technique, method.session,
        '按作者本次要求确定范围。讨论时直接给出建议。提交文学专家任务时，在 input.method 中填写 ' + method.name +
          '。所需工具须在本会话可用，缺少来源时说明待补材料。作者在对应面板确认采用、正式事实和创作方向。',
      ].join('\n\n'),
    })
  }
  ctx.effect(() => ctx.provide('literaryMethods',{list:listMethods,select:selectMethod}), 'lg-skills: specialist methods')
}
