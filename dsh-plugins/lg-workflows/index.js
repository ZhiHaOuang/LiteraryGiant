import { createWorkflows } from './src/service.js'
import {runHistory} from './src/run-history.js'
export const inject = ['literaryBooks','literaryAgents']
export function apply(ctx) {
  const service=createWorkflows(ctx.literaryBooks,ctx.literaryAgents,()=>ctx.get('literaryReview'),()=>ctx.get('literaryPlanning'))
  ctx.effect(()=>()=>service.dispose(),'lg-workflows: cancel pending steps')
  ctx.effect(()=>ctx.provide('literaryWorkflows',service),'lg-workflows: service')
  ctx.inject(['connection'], scope => {
  scope.effect(()=>scope.connection.fetch.register({path:'/api/lg/workflows',methods:['POST'],requestBody:'buffered',async fetch(request){
    try{
      const input=await request.json();let value
      if(input.action==='preview')value=service.preview(input.path,input.input)
      else if(['legacy-list','legacy-preview','legacy-import','history-list','history-read','history-version'].includes(input.action))value=await runHistory(ctx.literaryBooks,input.path,input)
      else if(input.action==='create')value=service.create(input.path,input.input,input.token,input.id)
      else if(input.action==='list')value=service.list(input.path,input.offset)
      else if(input.action==='read')value=service.read(input.path,input.id)
      else if(input.action==='checks')value=service.checks(input.path,input.id)
      else if(input.action==='choice-preview')value=service.choicePreview(input.path,input.id,input.option)
      else if(input.action==='choose')value=service.choose(input.path,input.id,input.option,input.token,input.operation)
      else if(input.action==='next-preview')value=service.nextPreview(input.path,input.id,input.feedback)
      else if(input.action==='advance')value=await service.advance(input.path,input.id,input.feedback,input.token,request.signal)
      else if(input.action==='recover')value=await service.recover(input.path,input.id,request.signal)
      else if(input.action==='stop')value=service.stop(input.path,input.id,input.token,input.reason)
      else if(input.action==='close')value=service.close(input.path,input.id,input.token)
      else throw new Error('未知工作流操作。')
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}})
    }catch(error){return Response.json({ok:false,error:error.message},{status:400})}
  }}),'lg-workflows: author API')
  })
}
