/** Han characters count individually; other letter/number sequences count as words. */
export function wordCount(text) {
  const han = text.match(/\p{Script=Han}/gu) ?? []
  const words = text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []
  return han.length + words.length
}

export function projectSummary(documents) {
  const active = documents.filter(row => !['candidate', 'rejected', 'archived'].includes(row.version_state))
  const sceneGroups = new Map()
  for (const scene of active.filter(row => row.kind === 'scene')) {
    if (!sceneGroups.has(scene.parent_id)) sceneGroups.set(scene.parent_id, [])
    sceneGroups.get(scene.parent_id).push(scene)
  }
  const chapters = active.filter(row => row.kind === 'chapter').map(row => {
    const scenes = sceneGroups.get(row.id) ?? []
    // A chapter with its own prose is authoritative; otherwise its scene parts supply prose.
    const parts = row.content?.trim() ? [row] : scenes
    return { id: row.id, slug: row.slug, title: row.title, sequence: row.sequence,
      version: row.version_number, state: row.state, source: parts === scenes ? 'scenes' : 'chapter',
      words: parts.reduce((sum, part) => sum + wordCount(part.content ?? ''), 0),
      acceptedWords: parts.filter(part => ['accepted', 'final'].includes(part.state))
        .reduce((sum, part) => sum + wordCount(part.content ?? ''), 0),
      updatedAt: row.updated_at }
  })
  return {
    chapters, words: chapters.reduce((sum, row) => sum + row.words, 0),
    acceptedWords: chapters.reduce((sum, row) => sum + row.acceptedWords, 0),
    written: chapters.filter(row => row.words > 0).length,
    characters: active.filter(row => row.kind === 'character').map(row => ({ id: row.id, title: row.title,
      state: row.state, summary: (row.content ?? '').slice(0, 300), version: row.version_number })),
    outlines: active.filter(row => row.kind === 'outline').map(row => ({ id: row.id, title: row.title, state: row.state })),
  }
}
