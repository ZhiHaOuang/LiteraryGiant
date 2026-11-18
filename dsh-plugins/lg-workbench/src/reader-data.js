export function readerChapter(path, data, chapters, bookTitle) {
  return {
    type: 'lg-reader:chapter',
    chapterId: JSON.stringify([path, data.document.id, data.selected.id]),
    title: data.document.title,
    text: data.selected.content,
    bookTitle,
    chapterIndex: chapters.findIndex(chapter => chapter.id === data.document.id) + 1,
  }
}

export function readerMessage(event, frameWindow) {
  if (!frameWindow || event.source !== frameWindow) return null
  if (event.data?.type === 'lg-reader:ready') return { type: 'ready' }
  if (event.data?.type === 'lg-reader:back') return { type: 'back' }
  if (event.data?.type === 'lg-reader:quote' && typeof event.data.text === 'string')
    return { type: 'quote', text: event.data.text }
  return null
}
