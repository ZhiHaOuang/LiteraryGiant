import { createReview } from './src/service.js'
export const inject = ['literaryBooks','literaryPlanning','literaryContext']
export function apply(ctx) {
  const review=createReview(ctx.literaryBooks,ctx.literaryPlanning,ctx.literaryContext)
  ctx.effect(()=>ctx.provide('literaryReview',review),'lg-review: versioned reviews')
  ctx.inject(['connection'], scope => {
  scope.effect(()=>scope.connection.fetch.register({path:'/api/lg/review',methods:['POST'],requestBody:'buffered',async fetch(request){
    try {
      const input=await request.json();let value
      if(input?.action==='consistency')value=review.consistency(input.path,input.target,input.operation)
      else if(input?.action==='quality')value=review.quality(input.path,input.target,input.operation)
      else if(input?.action==='quality-preview')value=review.qualityPreview(input.path,input.target)
      else if(input?.action==='check')value=review.check(input.path,input.target,input.rules)
      else if(input?.action==='list')value=review.list(input.path,input.target,input.offset)
      else if(input?.action==='read')value=review.read(input.path,input.run)
      else if(input?.action==='history')value=review.history(input.path,input.id)
      else if(input?.action==='preview')value=review.preview(input.path,input.change)
      else if(input?.action==='apply')value=review.apply(input.path,input.change,input.token,input.operation)
      else throw new Error('未知审阅操作。')
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}})
    }catch(error){return Response.json({ok:false,error:error.message},{status:400})}
  }}),'lg-review: author API')
  })
}
