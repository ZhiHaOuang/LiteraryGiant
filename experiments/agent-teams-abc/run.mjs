import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {createHash} from 'node:crypto'
import YAML from 'lg-yaml'
import * as Account from '@deepseek-ai/dsh-llm-deepseek-account'
import {runCell} from './lib/runtime.mjs'
import {Ledger,LIMITS} from './lib/ledger.mjs'
const root=resolve(import.meta.dirname),cell=process.argv[2],freeze=JSON.parse(readFileSync(join(root,'freeze.json'),'utf8'))
if(!/^(cal-[12]|new-[12])-[ABC]$/.test(cell??''))throw Error('Select exactly one frozen cell')
for(const [path,digest] of Object.entries(freeze.files))if(createHash('sha256').update(readFileSync(join(root,path))).digest('hex')!==digest)throw Error('Frozen file changed: '+path)
let auth;try{auth=JSON.parse(readFileSync(join(root,'private/authorization.json'),'utf8'))}catch{throw Error('No new model-call authorization; old 100-call budget is exhausted')}
if(auth.approved!==true||auth.limit!==LIMITS.requests||auth.freezeHash!==createHash('sha256').update(JSON.stringify(freeze)).digest('hex'))throw Error('Authorization does not match frozen experiment')
if(cell.startsWith('new-')){
 const gate=JSON.parse(readFileSync(join(root,'private/calibration-gate.json'),'utf8'))
 if(gate.allowHoldout!==true||gate.freezeHash!==auth.freezeHash)throw Error('Calibration gate not completed')
}
const caseData=JSON.parse(readFileSync(join(root,'private/cases.json'),'utf8')).find(c=>cell.startsWith(c.id+'-'))
const ledger=new Ledger(join(root,'private/requests.sqlite3'))
try{
 const result=await runCell({root,caseData,arm:cell.at(-1),runTag:freeze.runTag,ledger,provider:'deepseek-account',model:'deepseek-flash',async installAdapter(ctx){
  ctx.provide('deepseekAccount',{async resolveToken(endpoint){
   const url=new URL(endpoint);if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com'||url.port)return undefined
   try{const r=YAML.parse(readFileSync(join(homedir(),'.literarygiant-dsh/.credentials.yaml'),'utf8')).records['deepseek-account-platform/default'],grant=r.payload
    if(r.kind!=='grant'||grant.version!==1||grant.issuer.replace(/\/$/,'')!=='https://platform.deepseek.com'||typeof grant.token!=='string'||!grant.token||grant.token.startsWith('dsh_mock_'))throw Error('invalid')
    return grant.token
   }catch{throw Error('Validated DSH DeepSeek account unavailable; credential values not logged')}
  },async rejectToken(){}})
  await ctx.plugin(Account,{maxTokens:LIMITS.maxOutput,retryPolicy:{mode:'normal',maxRetries:0}})
 }})
 console.log(JSON.stringify({cell:result.cell,completed:result.completed,requests:result.requests,tokens:result.knownTokens,unknownUsage:result.unknownUsage,han:result.finalHan,totalRequests:ledger.rows().length}))
 if(!result.completed)process.exitCode=1
}finally{ledger.close()}
