import { chapterPath, createFile, readText } from './chapter-file-format.js'
import contracts from './analysis-contracts.json' with { type: 'json' }

const categories = Object.keys(contracts.cards)
const file = root => chapterPath(root, ['.literarygiant'], 'supervision.json')

export function readPolicy(book) {
  const raw = readText(file(book.root), 2_000_000)
  if (raw === null) return null
  const policy = JSON.parse(raw)
  if (policy?.schema !== 'lg.supervision.v1' || policy.project_id !== book.project.project_id ||
      !Array.isArray(policy.chapter_categories) || !policy.chapter_categories.length ||
      policy.chapter_categories.some(c => !categories.includes(c)) ||
      JSON.stringify(policy.volume_categories) !== JSON.stringify(categories))
    throw new Error('本书监督策略无效，无法采用正文。')
  return policy
}

// Existing policies, including a narrower set of chapter categories, belong to the book.
export function ensurePolicy(book) {
  const current = readPolicy(book)
  if (current) return current
  const policy = { schema: 'lg.supervision.v1', project_id: book.project.project_id,
    chapter_categories: categories, volume_categories: categories }
  try { createFile(file(book.root), JSON.stringify(policy, null, 2) + '\n') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const saved = readPolicy(book)
  if (!saved) throw new Error('作品监督策略发生变化，请刷新。')
  return saved
}
