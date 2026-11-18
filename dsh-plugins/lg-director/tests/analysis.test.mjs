import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {ToolsService,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import * as booksPlugin from '../../lg-books/index.js'
import * as agentsPlugin from '../../lg-agents/index.js'
import * as directorPlugin from '../index.js'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {categories,contract,finalizeCard} from '../../lg-library/src/contracts.js'
import {Executor} from '../../lg-execution/src/run.js'

test('native candidate supervision routes one scoped request; only author dispatch creates a report',async()=>{
  const path=realpathSync(mkdtempSync(join(tmpdir(),'lg-directed-report-')))
  createBook(path).db.close()
  writeFileSync(join(path,'.literarygiant/supervision.json'),JSON.stringify({schema:'lg.supervision.v1',project_id:'test-book',chapter_categories:['EventsLibrary'],volume_categories:['CharacterArc','EventsLibrary','PayoffAngst','EmotionRhythm','Worldview']}))
  const ctx=new Context(),fibers=[],calls=new Map()
  const pricing=new Executor(null,null,{provider:'fixture',model:'fixture',inputCnyPerMillion:1,outputCnyPerMillion:2,maxInputBytes:20000,maxOutputTokens:1024})
  const register=async(plugin,config)=>{const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber.await()}
  await register(c=>{
    c.provide('workingDirectory',{ensure:async()=>path});c.provide('systemPrompt',{tools:()=>()=>{}});c.provide('configEditor',{})
    c.provide('literaryLibrary',{contracts:()=>categories.map(contract),finalizeChapterCard:(c,card,evidence)=>finalizeCard(c,card,evidence,true)})
    c.provide('literaryExecution',{preview:i=>pricing.preview(i),status:id=>calls.get(id),async run(id,model){
      assert.ok(!calls.has(id));const p=JSON.parse(model.input)
      const fill=x=>Array.isArray(x)?[]:x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,fill(v)])):
        typeof x==='number'||['1-5','-2 to 2','0 to 2'].includes(x)?1:x.includes('/')?x.split('/')[0]:'交接'
      const text=JSON.stringify({summary:'钥匙交接',entries:[{key:'key',label:'交接',analysis:'旧钥匙交给守灯人。',evidence:[p.units[0].id],instance_card:fill(p.instance_card)}],findings:[]})
      const call={id,status:'succeeded',result:{text}};calls.set(id,call);return call
    }})
  })
  try {
    await register(ToolsService,{});await register(booksPlugin,{projects:[path]});await register(agentsPlugin,{roles:[]});await register(directorPlugin)
    const books=ctx.get('literaryBooks'),director=ctx.get('literaryDirector'),tools=ctx.get('tools'),exec={agent:{id:'book-session'},signal:new AbortController().signal}
    const token=books.manuscript(path,1).token,version=books.candidate(path,{document:1,version:1,token,reason:'审阅交接',content:'林澈把旧钥匙交给了守灯人。',operation:randomUUID()}).version
    const query=(action,args={})=>tools.get('literary_tasks').execute({action,...args},exec)
    const result=await query('supervision',{document:1,version})
    assert.deepEqual(validateJsonSchemaValue({type:'object'},result),[])
    assert.deepEqual(result.categories,[{category:'EventsLibrary',state:'missing',role:'plot'}]);assert.equal(result.target.token,token)
    const id=randomUUID(),request='核对旧钥匙的交接先后。',input={task:'candidate-analysis',target:{...result.target,category:'EventsLibrary'},request}
    const propose=()=>tools.get('literary_propose_task').execute({id,input},exec)
    assert.equal((await propose()).status,'proposed')
    const preview=director.preview(path,id)
    assert.equal(JSON.parse(preview.plan.modelInput.input).request,request);assert.equal(preview.plan.role,'plot')
    await assert.rejects(director.run(path,id,'forged'),/预览/);assert.equal(calls.size,0)
    const saved=await director.run(path,id,preview.token);assert.equal(saved.result.status,'analysis-ready')
    assert.equal(saved.result.report.entries[0].evidence[0].version_id,version)
    assert.equal((await query('supervision',{document:1,version})).categories[0].state,'current')
    assert.deepEqual((await query('read',{id})).result,{status:'analysis-ready',category:'EventsLibrary',entries:1,findings:0})
    assert.deepEqual((await propose()).result,(await query('read',{id})).result)
    assert.equal((await director.recover(path,id)).status,'completed');assert.equal(calls.size,1)
    assert.equal(books.manuscript(path,1).document.activeVersion,1)
    await assert.rejects(query('supervision',{document:1,version:1}),/候选/)
  } finally {for(const f of fibers.reverse())await f.dispose()}
})
