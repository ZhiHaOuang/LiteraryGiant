import {resolve,join} from 'node:path'
import {existsSync} from 'node:fs'
import {pathToFileURL,fileURLToPath} from 'node:url'
// Test-only access to the repository's pinned and built native DSH packages.
const root=resolve(process.env.LG_DSH_ROOT??fileURLToPath(new URL('../../../dsh',import.meta.url)))
const source={
 'cordis-plugin-loader':'../vendor/loader','cordis-plugin-group':'../vendor/group',
 'dsh-agent-preset-registry':'preset/agent-preset-registry',
 'dsh-token-meter':'llm/token-meter','dsh-commands':'interaction/commands',
 'dsh-user-questions':'interaction/user-questions',
 'dsh-llm':'llm/llm','dsh-agent-loop-testkit':'test-support/agent-loop-testkit',
 'dsh-agent-loop':'core/agent-loop','dsh-subagent':'subagent/subagent',
 'dsh-subagent-spawn-in-process':'subagent/subagent-spawn-in-process',
 'dsh-session-persistence-jsonl':'session/session-persistence-jsonl',
}
export const hostBaseUrl=pathToFileURL(join(root,'packages/bundle/web-app/cordis.yml')).href
export const native=async name=>{
 const installed=join(root,'node_modules/@deepseek-ai',name,'lib/index.js')
 const entry=existsSync(installed)?installed:join(root,'packages',source[name]??'unknown','lib/index.js')
 return import(pathToFileURL(entry).href)
}
