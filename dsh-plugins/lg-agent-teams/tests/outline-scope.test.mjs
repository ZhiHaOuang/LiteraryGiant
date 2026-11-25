import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createBook} from '../../lg-books/tests/fixture.mjs'
import {accessState} from '../../lg-books/src/state.js'
import {createOutline} from '../../lg-storydata/src/service.js'
import {proposeSummary,priorSummary,reviewTarget} from '../src/outline.js'

test('Main writes bind the version actually seen and citations to the frozen source',()=>{
  const path=mkdtempSync(join(tmpdir(),'lg-scope-'))
  createBook(path).db.close()
  const books={readState:(p,f)=>accessState(p,false,f),changeState:(p,f)=>accessState(p,true,f)}
  const outline=createOutline(books),source={path,book_id:'test-book',chapters:[{number:1,document_id:1,version_id:1,paragraphs:['林澈关上灯。海风停了。']}]}
  const item={id:'lin',section:'people',title:'林澈',text:'林澈关灯。',basis:'text',links:[],evidence:[{chapter:1,paragraph:1,quote:'林澈关上灯'}]}
  const input={beat:'灯灭',changes:[item]},task={child:'first',outline_priors:{lin:0}}
  const propose=(source,task,input)=>proposeSummary(outline,books,source,task,input)
  assert.throws(()=>propose(source,{child:'invalid'},input),/先用/)
  assert.throws(()=>propose(source,task,{...input,changes:[{...item,evidence:[{...item.evidence[0],chapter:2}]}]}),/引文/)
  const {token}=propose(source,task,input)
  outline.review(path,token,{decision:'approved',reason:'有原文支持'},'second');outline.commit(path,token)
  assert.throws(()=>propose(source,{...task,child:'stale'},input),/版本已变化/)
  assert.throws(()=>priorSummary(outline,{...source,chapters:[]},'lin'),/任务范围外/)
  const proposal={owner:'root',source_id:'s',child:'first',status:'completed',outline_action:'propose',artifact:{token}}
  const review={owner:'root',source_id:'s',inputs:['p'],child:'second'},store={task:()=>proposal}
  assert.throws(()=>reviewTarget(outline,store,source,{...review,child:'first'}),/独立提议/)
  assert.throws(()=>reviewTarget(outline,store,source,{...review,owner:'other'}),/独立提议/)
  assert.throws(()=>reviewTarget(outline,store,source,{...review,source_id:'other'}),/独立提议/)
})

