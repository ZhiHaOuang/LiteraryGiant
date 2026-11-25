import {createOutline} from './src/service.js'
import {overview,bookInventory} from './src/inventory.js'
import {createSpaceReader} from './src/space-history.js'
export const inject = ['literaryBooks']

export function apply(ctx) {
  const books=ctx.literaryBooks
  const space=createSpaceReader(books,{profile:ctx.get('profileContext')?.dir,segments:()=>ctx.get('literaryPlotSegments')})
  ctx.effect(()=>()=>space.close(),'lg-storydata: storage measurements')
  const service={...createOutline(books),storage:space.read,overview:(_path,options)=>overview(books,options),book:(path,options)=>bookInventory(books,path,options)}
  ctx.effect(()=>ctx.provide('literaryStoryData',service),'lg-storydata: story data')
  ctx.effect(()=>ctx.provide('literaryOutline',service),'lg-outline: Main dossiers')
  for(const route of ['outline','storydata']) ctx.inject(['connection'],scope=>scope.effect(()=>scope.connection.fetch.register({
    path:'/api/lg/'+route, methods:['POST'], requestBody:'buffered',
    async fetch(request) {
      const headers = {'cache-control':'no-store'}
      try {
        const {action,path,options} = await request.json()
        const allowed=route==='outline'?['main','character']:['overview','book','storage','main','character']
        if (!allowed.includes(action)) throw Error('未知资料读取操作')
        return Response.json({ok:true,value:await service[action](path,options)},{headers})
      } catch (error) {
        return Response.json({ok:false,error:error.message},{status:400,headers})
      }
    }
  }),'lg-storydata: '+route))
}

