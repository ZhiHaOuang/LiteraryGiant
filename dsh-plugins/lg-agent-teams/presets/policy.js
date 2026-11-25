import z from '@deepseek-ai/schemastery'
import {presetIds,presetPrompt,mainPresetTools,memberTools} from './roles.js'

export const name='lg-preset-policy'
export const inject=['tools','systemPrompt']
export const Config=z.object({role:z.union(Object.keys(presetIds).map(v=>z.const(v))).required()})
/** Preset-scoped persona and capability policy; never a second AgentLoop. */
export function apply(ctx,config){
  const allow=config.role==='coordinator'?mainPresetTools:[...memberTools(config.role),
    ...(config.role==='analysis'?['lg_outline_prior','lg_outline_propose','lg_outline_review']:[])]
  // The host binds the allow-list to agent.ctx after the preset is mounted.
  // Filtering here would also hide preset-local ask_user_question from descendants.
  ctx.effect(()=>ctx.tools.guard(exec=>allow.includes(exec.name)?undefined:'此文学职责没有该工具权限'),'lg-preset: execution guard')
  ctx.effect(()=>ctx.systemPrompt.section({name:'deployment:persona-prefix',order:ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),interpolate:false,text:presetPrompt(config.role)}),'lg-preset: persona')
  ctx.effect(()=>ctx.systemPrompt.section({name:'deployment:persona-suffix',order:ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),text:''}),'lg-preset: suffix')
}
