import z from '@deepseek-ai/schemastery'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const name = 'lg-agent-preflight'
export const inject = ['llm']
export const Config = z.object({ toolNames: z.array(z.string()).required() })

/** Validate selected model-facing contracts without rewriting the request. */
export function checkToolContracts(tools, names) {
  for (const tool of tools ?? []) {
    if (!names.has(tool.name)) continue
    try {
      assertObjectJsonSchema(tool.parameters)
    } catch (cause) {
      throw new LlmError(`Tool "${tool.name}" has an invalid parameter schema. Fix its registration before requesting the model.`, 'TOOL_PARAMETER_SCHEMA_INVALID', { cause })
    }
  }
}

export function apply(ctx, config) {
  if (!Array.isArray(config.toolNames) || config.toolNames.length === 0
    || config.toolNames.some(name => typeof name !== 'string' || name.trim() !== name || name.length === 0)
    || new Set(config.toolNames).size !== config.toolNames.length) {
    throw new TypeError('lg-agent-preflight requires unique, nonempty toolNames')
  }
  const names = new Set(config.toolNames)
  ctx.on('llm/stream', async function* (options, next) {
    checkToolContracts(options.tools, names)
    yield* next()
  })
}
