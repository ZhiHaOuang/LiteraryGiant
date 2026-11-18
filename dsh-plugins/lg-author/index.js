import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAuthor } from './src/service.js'
export const inject=['literaryBooks','profileContext']
export const Config=z.object({legacyPersonalPath:z.string().default('')})
export function apply(ctx,config) {
  const service=createAuthor(ctx.literaryBooks,join(ctx.profileContext.dir,'lg-author.sqlite3'),config.legacyPersonalPath||join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'literarygiant/preferences.json'))
  ctx.effect(()=>()=>service.close(),'lg-author: close preferences')
  ctx.effect(()=>ctx.provide('literaryAuthor',service),'lg-author: service')
  ctx.inject(['connection'], scope => {
  scope.effect(()=>scope.connection.fetch.register({path:'/api/lg/author',methods:['POST'],requestBody:'buffered',async fetch(request){
    try{
      const input=await request.json();let value
      if(input.action==='read')value=service.read(input.path)
      else if(input.action==='preview')value=service.preview(input.path,input.change)
      else if(input.action==='apply')value=service.apply(input.path,input.change,input.token,input.operation)
      else if(input.action==='history')value=service.history(input.path,input.scope,input.offset)
      else throw new Error('未知偏好操作。')
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}})
    }catch(error){return Response.json({ok:false,error:error.message},{status:400})}
  }}),'lg-author: author API')
  })
}
