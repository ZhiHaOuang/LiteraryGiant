export function groupRows(rows, books) {
  const ordered=[...books].sort((a,b)=>b.path.length-a.path.length)
  const rowsByBook=new Map(books.map(book=>[book.path,[]]))
  rowsByBook.set('unbound',[])
  const bookByRow=new Map()
  const lastActivity=new Map(books.map(book=>[book.path,Math.max(0,...(book.chapters??[]).map(c=>Date.parse(c.updatedAt)||0))]))
  for(const row of rows) {
    const book=row.cwd ? ordered.find(book=>row.cwd===book.path||row.cwd.startsWith(book.path.replace(/\/$/,'')+'/')) : undefined
    bookByRow.set(row,book??null)
    rowsByBook.get(book?.path??'unbound').push(row)
    if(book)lastActivity.set(book.path,Math.max(lastActivity.get(book.path),row.updatedAt))
  }
  return {rowsByBook,bookByRow,lastActivity}
}
export function dateKeys(from, to) {
  const start = new Date(from+'T12:00:00'), end = new Date(to+'T12:00:00'), keys=[]
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || start>end) return keys
  for (let date=start;date<=end && keys.length<36600;date.setDate(date.getDate()+1)) keys.push(localDay(date))
  return keys
}
export function localDay(date=new Date()) {
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')
}
export function pendingItems(books) {
  return books.flatMap(book=>book.chapters.filter(chapter=>chapter.pendingVersions>0).map(chapter=>({
    key:book.path+':'+chapter.id, book, chapter, count:chapter.pendingVersions,
  })))
}
