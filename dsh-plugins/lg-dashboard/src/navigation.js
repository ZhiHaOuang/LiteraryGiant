export function bindBookshelfEntry(document,showGlobal){
 const activate=event=>{
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return
  const button=event.target.closest?.('button')
  if(button?.querySelector('[data-lg-bookshelf-entry]'))showGlobal()
 }
 document.addEventListener('click',activate,true)
 return()=>document.removeEventListener('click',activate,true)
}
