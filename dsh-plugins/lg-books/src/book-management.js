import {describeBook} from './read.js'

// Shelf membership lives in plugin settings; never move or delete manuscript files.
export function createBookManagement(shelf,persist){
 let pending=Promise.resolve()
 const serial=task=>{const result=pending.then(task);pending=result.catch(()=>{});return result}
 const without=(values,path)=>(values??[]).filter(value=>value!==path)
 return {
  add:path=>serial(async()=>{
   const book=describeBook(path)
   await persist(current=>({...current,projects:[...new Set([...(current.projects??[]),book.path])],
    archivedProjects:without(current.archivedProjects,book.path),removedProjects:without(current.removedProjects,book.path)}))
   await shelf.sync()
   return book
  }),
  change:input=>serial(async()=>{
   if(!['archive','restore','remove'].includes(input.action)||input.confirmed!==true)throw Error('请确认作品及书架操作。')
   const book=shelf.list({includeArchived:true}).find(book=>book.path===input.path)
   if(!book||book.error||!input.id||book.id!==input.id)throw Error('作品已变化或不在书架中，请刷新后重试。')
   await persist(current=>{
    const archived=without(current.archivedProjects,book.path),removed=without(current.removedProjects,book.path)
    return {...current,projects:input.action==='remove'?without(current.projects,book.path):[...new Set([...(current.projects??[]),book.path])],
     archivedProjects:input.action==='archive'?[...archived,book.path]:archived,
     removedProjects:input.action==='remove'?[...removed,book.path]:removed}
   })
   return shelf.sync()
  }),
 }
}
