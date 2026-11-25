import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

export const presetIds=Object.freeze({coordinator:'lg',analysis:'lg-analysis',planning:'lg-planning',writing:'lg-writing'})
export const mainPresetTools=Object.freeze(['lg_team_catalog','lg_team_prepare','lg_team_source','lg_team_delegate','lg_team_result','lg_team_cancel','lg_team_outline_commit','ask_user_question'])
export const memberTools=role=>['lg_team_context','lg_'+role+'_submit']
export function presetPrompt(role){
  if(!Object.hasOwn(presetIds,role))throw Error('未知文学预设职责')
  return readFileSync(new URL('./prompts/'+role+'.md',import.meta.url),'utf8')
}
export const presetHash=role=>createHash('sha256').update(presetPrompt(role)).digest('hex')
export const presetCatalog=()=>Object.entries(presetIds).map(([role,preset])=>({id:role,preset,executor:'native',version:'preset-v1',prompt:presetPrompt(role),method:null}))
