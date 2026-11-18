import { createHash } from 'node:crypto'
import catalog from './catalog.json' with { type: 'json' }

export function listMethods(task) {
  return catalog.filter(method => method.tasks.includes(task)).map(({name,title,description}) => ({name,title,description}))
}

export function selectMethod(task, name) {
  const method = catalog.find(item => item.name === name && item.tasks.includes(task))
  if (!method) throw new Error('所选文学方法不存在或不适用于此任务。')
  const {title,technique} = method
  const digest = createHash('sha256').update(JSON.stringify([name,title,technique])).digest('hex')
  return {name,title,technique,digest}
}
