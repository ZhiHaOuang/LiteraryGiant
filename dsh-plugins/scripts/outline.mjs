import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {accessState} from '../lg-books/src/state.js'
import {createOutline} from '../lg-storydata/src/service.js'

// Local trusted adapter. A path is an explicit book selection for this process only.
const help = `用法: node dsh-plugins/scripts/outline.mjs ACTION BOOK [参数]
  main [people|plot|world|all] [OFFSET]  读取当前摘要
  character ID               读取人物八类 Main
  propose ACTOR              从 stdin 读取 lg.outline.change.v1
  inspect TOKEN              比较上次摘要与候选
  review TOKEN REVIEWER      从 stdin 读取 {"decision":"approved|rejected","reason":"..."}
  commit TOKEN               提交已审查版本
  history ID MODULE [OFFSET] 条目来源和历史
  packs                      查看本书模块
  enable-pack                从 stdin 读取本书扩展定义`
function run([action,book,...args]) {
  if (action==='--help' || action==='-h') return help
  const arities = {character:[1],main:[0,1,2],propose:[1],inspect:[1],review:[2],commit:[1],history:[2,3],packs:[0],'enable-pack':[0]}
  if (!book || !Object.hasOwn(arities,action) || !arities[action].includes(args.length)) throw Error(help)
  const path = resolve(book)
  const api = createOutline({
    readState:(book,fn)=>accessState(book,false,fn), changeState:(book,fn)=>accessState(book,true,fn)
  })
  const input = ()=>JSON.parse(readFileSync(0,'utf8'))
  switch (action) {
    case 'character': return api.character(path,{id:args[0]})
    case 'main': return api.main(path,{section:args[0]==='all'?undefined:args[0],offset:Number(args[1]??0)})
    case 'propose': return api.propose(path,input(),args[0])
    case 'inspect': return api.inspect(path,args[0])
    case 'review': return api.review(path,args[0],input(),args[1])
    case 'commit': return api.commit(path,args[0])
    case 'history': return api.history(path,{id:args[0],module:args[1],offset:Number(args[2]??0)})
    case 'packs': return api.packs(path)
    case 'enable-pack': return api.enablePack(path,input())
  }
}
try {
  const result = run(process.argv.slice(2))
  console.log(typeof result==='string'?result:JSON.stringify(result,null,2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

