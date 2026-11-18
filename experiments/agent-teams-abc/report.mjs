import {readFileSync,writeFileSync,existsSync,readdirSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {randomInt} from 'node:crypto'
const root=resolve(import.meta.dirname),cases=JSON.parse(readFileSync(join(root,'private/cases.json'),'utf8'))
const reports=join(root,'reports');mkdirSync(reports,{recursive:true,mode:0o700})
const results=existsSync(join(root,'runs'))?readdirSync(join(root,'runs')).filter(x=>/^v2-(cal|new)-[12]-[ABC]$/.test(x)).map(x=>join(root,'runs',x,'result.json')).filter(existsSync).map(x=>JSON.parse(readFileSync(x,'utf8'))):[]
const keyPath=join(root,'private/blind-key.json');let key=existsSync(keyPath)?JSON.parse(readFileSync(keyPath,'utf8')):{}
for(const c of cases){
 const runs=results.filter(x=>x.caseId===c.id)
 if(runs.length!==3)continue
 if(!key[c.id]){const shuffled=[...runs];for(let i=2;i>0;i--){const j=randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]}key[c.id]=Object.fromEntries(shuffled.map((r,i)=>[String.fromCharCode(88+i),r.cell]))}
 let text=`# ${c.id} 匿名候选\n\n${c.brief}\n\n## 审读约束\n\n${c.criteria.map(x=>'- '+x).join('\n')}\n\n`
 for(const [label,cell] of Object.entries(key[c.id])){const r=runs.find(x=>x.cell===cell);text+=`## 候选 ${label}\n\n${r?.artifacts?.final?.text??'本组未交付合格正文。'}\n\n`}
 text+='## 评分表\n\n逐条记录约束判断及对应句子。每份角色选择/场景推进/语言对白各0—2分，采用程度0—3；请选择偏好或无法区分。先写评分再看版本。\n'
 writeFileSync(join(reports,c.id+'-blind.md'),text,{mode:0o600})
}
writeFileSync(keyPath,JSON.stringify(key,null,2)+'\n',{mode:0o600})
const summary=results.map(({cell,split,completed,requests,knownTokens,unknownUsage,elapsedMs,firstDraftHan,finalHan})=>({cell,split,completed,requests,knownTokens,unknownUsage,elapsedMs,firstDraftHan,finalHan}))
writeFileSync(join(reports,'mechanical.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify({results:results.length,complete:results.filter(x=>x.completed).length,requests:results.reduce((n,x)=>n+x.requests,0),blindSets:Object.keys(key).length}))
