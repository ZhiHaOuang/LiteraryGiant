import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const read=(directory,name)=>readFileSync(new URL(`../${directory}/${name}.md`,import.meta.url),'utf8')
export const roles=Object.freeze([
  {id:'analysis',name:'分析',description:'阅读指定正文，区分事实、认知、推测与未知，交付带出处的分析。',output:'证据报告'},
  {id:'planning',name:'规划',description:'根据作者目标和已知状态推演方向、冲突与场景，交付候选方案。',output:'候选规划'},
  {id:'writing',name:'创作',description:'根据作者要求及可选规划写出完整正文，保留风险与待决问题。',output:'候选正文'},
].map(role=>({...role,version:'1.1.0',prompt:read('prompts',role.id),method:read('methods',role.id)})))
export const coordinator=read('prompts','coordinator')
export function roleOf(id){const role=roles.find(r=>r.id===id);if(!role)throw Error('未知文学职责');return role}
export function rolePrompt(id,method=true){const role=roleOf(id);return role.prompt+(method?'\n\n'+role.method:'')}
export function promptHash(id,method=true){return createHash('sha256').update(rolePrompt(id,method)).digest('hex')}
