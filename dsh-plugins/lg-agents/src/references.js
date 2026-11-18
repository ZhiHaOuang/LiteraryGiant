export function taskReferences(path, tokens = [], library) {
  if (!Array.isArray(tokens) || tokens.length > 3 || new Set(tokens).size !== tokens.length || tokens.some(token => typeof token !== 'string' || token.length > 4096)) {
    throw new Error('每次任务最多选择 3 条不重复的资料引用。')
  }
  if (!tokens.length) return []
  if (!library) throw new Error('本次任务包含资料引用，请先启用 lg-library。')
  return tokens.map(citation => {
    const source = library.read(path, citation)
    return { citation, id: source.id, tier: source.tier, file: source.file, sha256: source.sha256,
      text: source.text.slice(0, 1200), truncated: source.text.length > 1200 }
  })
}
