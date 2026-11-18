import {presetIds} from './roles.js'

export const name='lg-agent-presets'
export const inject=['agentPresets','literaryTeams']
const names={coordinator:'LG 主 Agent',analysis:'LG 分析',planning:'LG 规划',writing:'LG 创作'}
const descriptions={coordinator:'与作者讨论，可直接处理小任务，并按需委派三种文学职责。',analysis:'主 Agent 按需派发：核对指定正文、人物认知与来源。',planning:'主 Agent 按需派发：提出尚未采纳的情节或场景方案。',writing:'主 Agent 按需派发：依据指定来源写候选正文。'}
/** Standard-derived composition: native execution, scoped tools and native compaction. */
export function definitions(){return Object.entries(presetIds).map(([role,id],order)=>({
  id,name:names[role],description:descriptions[role],order:10+order,
  plugins:[
    {id:'literary-policy',name:new URL('./policy.js',import.meta.url).href,config:{role}},
    {id:'native-executor',name:'@deepseek-ai/dsh-tool-executor-native'},
    {id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true,toolResultPruner:true},config:[
      {id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'},
      {id:'command-compact',name:'@deepseek-ai/dsh-command-compact'},
      {id:'tool-result-pruner',name:'@deepseek-ai/dsh-compaction-tool-result-pruner',config:{thresholdChars:8192,headChars:4096,tailChars:1024}},
    ]},
    ...(role==='coordinator'?[{id:'ask-author',name:'@deepseek-ai/dsh-tool-ask-user'}]:[]),
  ],
}))}
export async function* apply(ctx){for(const definition of definitions())yield await ctx.agentPresets.register(definition)}
