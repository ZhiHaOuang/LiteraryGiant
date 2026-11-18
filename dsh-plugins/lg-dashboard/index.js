export const inject = ['literaryBooks']
export function apply(ctx) {
  ctx.inject(['connection'],scope=>scope.effect(()=>scope.connection.fetch.register({
    path:'/api/lg/dashboard/providers',methods:['POST'],
    async fetch() {
      const llm=ctx.get('llm')
      if(!llm?.listProviders)return Response.json({ok:false,providers:[]},{headers:{'cache-control':'no-store'}})
      try {
        const providers=(await llm.listProviders()).map(({id,name})=>({id,name}))
        return Response.json({ok:true,providers},{headers:{'cache-control':'no-store'}})
      } catch {return Response.json({ok:false,providers:[]},{headers:{'cache-control':'no-store'}})}
    },
  }),'lg-dashboard: provider directory'))
}
