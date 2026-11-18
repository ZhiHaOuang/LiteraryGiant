import {test} from 'node:test'
import assert from 'node:assert/strict'
import {groupRows,dateKeys,pendingItems} from '../src/global-data.js'
test('book attribution uses path boundaries and most specific registered book',()=>{
 const books=[{path:'/books/a',chapters:[{updatedAt:'2026-11-01'}]},{path:'/books/a/sequel'}]
 const rows=['/books/ab','/books/a/chapters','/books/a/sequel/chapters',undefined].map((cwd,i)=>({cwd,updatedAt:100+i}))
 const grouped=groupRows(rows,books)
 assert.deepEqual(rows.map(row=>grouped.bookByRow.get(row)),[null,books[0],books[1],null])
 assert.deepEqual(grouped.rowsByBook.get('unbound'),[rows[0],rows[3]])
 assert.deepEqual(grouped.rowsByBook.get('/books/a'),[rows[1]])
 assert.equal(grouped.lastActivity.get('/books/a'),Date.parse('2026-11-01'))
 assert.equal(grouped.lastActivity.get('/books/a/sequel'),102)
 assert.deepEqual(books.map(b=>b.path),['/books/a','/books/a/sequel'])
})
test('inclusive local day windows handle month boundaries and reversed ranges',()=>{
 assert.deepEqual(dateKeys('2026-10-31','2026-11-02'),['2026-10-31','2026-11-01','2026-11-02'])
 assert.deepEqual(dateKeys('2026-11-02','2026-11-01'),[])
 assert.deepEqual(dateKeys('',''),[])
})
test('review links retain exact book and chapter, excluding chapters without candidates',()=>{
 const book={path:'/synthetic',chapters:[{id:3,pendingVersions:2},{id:4,pendingVersions:0}]}
 const rows=pendingItems([book]);assert.equal(rows.length,1)
 assert.equal(rows[0].book,book);assert.equal(rows[0].chapter.id,3);assert.equal(rows[0].count,2)
})
