import { digest } from './manuscript.js'
import { listDocuments, readDocument } from './documents-read.js'
import { planDocument, applyDocument, documentOperation } from './documents-write.js'
export function createDocuments(books, verifyGeneration) {
  return {
    list(path, input) { return books.readState(path, db => listDocuments(db,input)) },
    read(path, id, version) { return books.readState(path, db => readDocument(db,id,version)) },
    preview(path, change) { return books.readState(path, db => { const value = planDocument(db,change);return { value,token:digest({path,value}) } }) },
    apply(path, change, token, operation) {
      return books.changeState(path, db => documentOperation(db,operation,digest({change,token}),() => {
        const value = planDocument(db,change)
        if (token !== digest({path,value})) throw new Error('资料预览或来源已变化，请重新预览。')
        return applyDocument(db,value,generation => verifyGeneration(path,generation))
      }))
    },
    candidate(path, change, operation) {
      if (change?.action !== 'candidate') throw new Error('模型只能保存资料候选。')
      return books.changeState(path, db => documentOperation(db,operation,digest({proposal:change}),() => applyDocument(db,planDocument(db,change))))
    },
  }
}
