/**
 * 面板文案词典（zh / en），经 ctx.locale.register 注册，命名空间 dsh-reading-workbench。
 */
export type WorkbenchKey =
  | 'entry.label'
  | 'panel.title'
  | 'shelf.title'
  | 'shelf.empty'
  | 'shelf.empty.hint'
  | 'shelf.import'
  | 'shelf.import.hint'
  | 'shelf.drop'
  | 'shelf.count'
  | 'shelf.search'
  | 'shelf.sort.recent'
  | 'shelf.sort.title'
  | 'shelf.sort.author'
  | 'shelf.noresult'
  | 'shelf.remove'
  | 'shelf.remove.confirm'
  | 'shelf.open'
  | 'import.working'
  | 'import.done'
  | 'import.unsupported'
  | 'reader.untitled'
  | 'reader.loading'
  | 'reader.fetchingChapter'
  | 'reader.fetchFailed.hint'
  | 'reader.retry'
  | 'reader.chapterStatus'
  | 'reader.chapterStatus.unknown'
  | 'reader.chapterLegend'
  | 'reader.back'
  | 'reader.page'
  | 'reader.chapter'
  | 'reader.prev'
  | 'reader.next'
  | 'reader.prevPage'
  | 'reader.nextPage'
  | 'reader.settings'
  | 'reader.layout'
  | 'reader.layout.auto'
  | 'reader.layout.one'
  | 'reader.layout.two'
  | 'reader.fontSize'
  | 'reader.fontSmaller'
  | 'reader.fontLarger'
  | 'reader.txtReflow'
  | 'reader.txtReflow.auto'
  | 'reader.txtReflow.preserve'
  | 'reader.bookCss'
  | 'reader.bookCss.book'
  | 'reader.bookCss.unified'
  | 'reader.bookCss.failed'
  | 'reader.fontFamily'
  | 'reader.fontFamily.system'
  | 'reader.fontFamily.serif'
  | 'reader.fontFamily.sans'
  | 'reader.progress.saved'
  | 'reader.progress'
  | 'pdf.rendering'
  | 'mark.button'
  | 'mark.drawer'
  | 'mark.count'
  | 'mark.empty'
  | 'mark.delete'
  | 'mark.notePlaceholder'
  | 'mark.saved'
  | 'mark.tooLong'
  | 'mark.jump'
  | 'highlight.create'
  | 'highlight.delete'
  | 'highlight.note.placeholder'
  | 'highlight.empty'
  | 'error.load'
  // ── 网页书源 ──
  | 'web.title'
  | 'web.badge'
  | 'web.form.placeholder'
  | 'web.form.hint'
  | 'web.submit'
  | 'web.submitting'
  | 'web.cancel'
  | 'web.invalid'
  | 'web.progress'
  | 'web.progress.fetching'
  | 'web.progress.done'
  | 'web.progress.stopped'
  | 'web.progress.errors'
  | 'web.start'
  | 'web.stop'
  | 'web.resume'
  | 'web.close'
  | 'web.hint.partial'
  | 'web.hint.autofetch'
  // ── 划线失败的三类原因（静默失败改为显式提示）──
  | 'mark.failed.notReady'
  | 'mark.failed.selectionLost'
  | 'mark.failed.outOfFlow'
  | 'mark.failed.empty';

/** 中文词典（默认语言）。 */
export const zh: Record<WorkbenchKey, string> = {
  'entry.label': '阅读',
  'panel.title': '阅读工作台',
  'shelf.title': '书架',
  'shelf.empty': '书架还是空的',
  'shelf.empty.hint': '把 .epub / .mobi / .pdf / .md / .txt 拖进来，或点右上角导入',
  'shelf.import': '导入书籍',
  'shelf.import.hint': '支持 .md / .txt / .html / .epub / .mobi / .pdf',
  'shelf.drop': '松开即导入',
  'shelf.count': '本',
  'shelf.search': '搜索书名或作者',
  'shelf.sort.recent': '最近添加',
  'shelf.sort.title': '按书名',
  'shelf.sort.author': '按作者',
  'shelf.noresult': '没有匹配的书',
  'shelf.remove': '移除',
  'shelf.remove.confirm': '从书架移除？原文件不会被删除。',
  'shelf.open': '开始阅读',
  'import.working': '导入中…',
  'import.done': '导入完成',
  'import.unsupported': '仅支持 .md / .txt / .html / .epub / .mobi / .pdf 文件',
  'reader.untitled': '未打开书籍',
  'reader.loading': '加载中…',
  'reader.fetchingChapter': '正在抓取本章…（首次打开约需几秒）',
  'reader.fetchFailed.hint': '这一章还没抓到本地，抓取失败了。可稍后点「重试」；已下载的章节不受影响。',
  'reader.retry': '重试',
  'reader.chapterStatus': '已下载 {fetched} / 共 {total} 章',
  'reader.chapterStatus.unknown': '下载状态未知',
  'reader.chapterLegend': '✓ 已下载 · ↓ 未下载（点开自动抓取）',
  'reader.back': '返回书架',
  'reader.page': '页',
  'reader.chapter': '章节',
  'reader.prev': '上一章',
  'reader.next': '下一章',
  'reader.prevPage': '上一页',
  'reader.nextPage': '下一页',
  'reader.settings': '阅读设置',
  'reader.layout': '版式',
  'reader.layout.auto': '自适应',
  'reader.layout.one': '单页',
  'reader.layout.two': '双页',
  'reader.fontSize': '字号',
  'reader.fontSmaller': '缩小字号',
  'reader.fontLarger': '放大字号',
  'reader.txtReflow': '换行',
  'reader.txtReflow.auto': '自动合并',
  'reader.txtReflow.preserve': '保留原样',
  'reader.bookCss': '排版',
  'reader.bookCss.book': '原书排版',
  'reader.bookCss.unified': '统一美化',
  'reader.bookCss.failed': '本书样式加载失败，已按统一美化显示',
  'reader.fontFamily': '字体',
  'reader.fontFamily.system': '默认字体',
  'reader.fontFamily.serif': '宋体',
  'reader.fontFamily.sans': '黑体',
  'reader.progress.saved': '进度已保存',
  'reader.progress': '进度',
  'pdf.rendering': 'PDF 渲染中…',
  'mark.button': '划线',
  'mark.drawer': '划线与笔记',
  'mark.count': '条',
  'mark.empty': '选中正文文字即可划线，划过的句子会留在这里。',
  'mark.delete': '删除',
  'mark.notePlaceholder': '给这段写点笔记…（可选）',
  'mark.saved': '已划线',
  'mark.tooLong': '划线内容过长，请缩短选区',
  'mark.jump': '定位',
  'highlight.create': '划线',
  'highlight.delete': '删除',
  'highlight.note.placeholder': '写点笔记…',
  'highlight.empty': '还没有划线。',
  'error.load': '加载失败',
  // 网页书源
  'web.title': '添加网页书源',
  'web.badge': '网页',
  'web.form.placeholder': '粘贴小说章节页或目录页 URL',
  'web.form.hint': '先抓目录和第 1 章建书，其余章节自动续抓；抓完就是一本本地书，可正常阅读与划线。',
  'web.submit': '抓取',
  'web.submitting': '正在读取目录…',
  'web.cancel': '取消',
  'web.invalid': 'URL 必须以 http:// 或 https:// 开头',
  'web.progress': '已抓 {fetched} / 共 {total} 章',
  'web.progress.fetching': '正在续抓…',
  'web.progress.done': '已抓完',
  'web.progress.stopped': '已暂停',
  'web.progress.errors': '{count} 章抓取失败',
  'web.start': '抓取剩余章节',
  'web.stop': '暂停',
  'web.resume': '继续',
  'web.close': '关闭进度',
  'web.hint.partial': '还有部分章节没抓，点「抓取剩余章节」续抓（或直接阅读已抓到的部分）。',
  'web.hint.autofetch': '未下载的章节点开时会自动抓取（首次约几秒），已下载的章节可离线阅读。',
  // ── 划线失败提示 ──
  'mark.failed.notReady': '划线失败：正文还未就绪，请稍候再试',
  'mark.failed.selectionLost': '划线失败：选区已丢失，请重新选中文字后再点划线',
  'mark.failed.outOfFlow': '划线失败：选区不在正文范围内，请只选中正文文字',
  'mark.failed.empty': '划线失败：选区没有可用文本',
};

/** 英文词典。 */
export const en: Record<WorkbenchKey, string> = {
  'entry.label': 'Reading',
  'panel.title': 'Reading Workbench',
  'shelf.title': 'Bookshelf',
  'shelf.empty': 'Your shelf is empty',
  'shelf.empty.hint': 'Drop .epub / .mobi / .pdf / .md / .txt files here, or use Import',
  'shelf.import': 'Import',
  'shelf.import.hint': '.md / .txt / .html / .epub / .mobi / .pdf',
  'shelf.drop': 'Drop to import',
  'shelf.count': 'books',
  'shelf.search': 'Search title or author',
  'shelf.sort.recent': 'Recently added',
  'shelf.sort.title': 'By title',
  'shelf.sort.author': 'By author',
  'shelf.noresult': 'No matching book',
  'shelf.remove': 'Remove',
  'shelf.remove.confirm': 'Remove from shelf? The original file is kept.',
  'shelf.open': 'Start reading',
  'import.working': 'Importing…',
  'import.done': 'Import finished',
  'import.unsupported': 'Only .md / .txt / .html / .epub / .mobi / .pdf files are supported',
  'reader.untitled': 'No book open',
  'reader.loading': 'Loading…',
  'reader.fetchingChapter': 'Fetching this chapter… (a few seconds on first open)',
  'reader.fetchFailed.hint':
    'This chapter has not been downloaded yet and fetching it failed. Try "Retry" later; downloaded chapters are unaffected.',
  'reader.retry': 'Retry',
  'reader.chapterStatus': '{fetched} / {total} chapters downloaded',
  'reader.chapterStatus.unknown': 'Download status unknown',
  'reader.chapterLegend': '✓ downloaded · ↓ not downloaded (fetched on open)',
  'reader.back': 'Back to shelf',
  'reader.page': 'Page',
  'reader.chapter': 'Chapter',
  'reader.prev': 'Previous chapter',
  'reader.next': 'Next chapter',
  'reader.prevPage': 'Previous page',
  'reader.nextPage': 'Next page',
  'reader.settings': 'Reading settings',
  'reader.layout': 'Layout',
  'reader.layout.auto': 'Auto',
  'reader.layout.one': 'Single',
  'reader.layout.two': 'Double',
  'reader.fontSize': 'Font size',
  'reader.fontSmaller': 'Smaller font',
  'reader.fontLarger': 'Larger font',
  'reader.txtReflow': 'Line breaks',
  'reader.txtReflow.auto': 'Reflow',
  'reader.txtReflow.preserve': 'Keep as-is',
  'reader.bookCss': 'Layout style',
  'reader.bookCss.book': "Book's own",
  'reader.bookCss.unified': 'Unified',
  'reader.bookCss.failed': "Failed to load this book's styles; showing the unified layout",
  'reader.fontFamily': 'Font',
  'reader.fontFamily.system': 'Default',
  'reader.fontFamily.serif': 'Serif',
  'reader.fontFamily.sans': 'Sans',
  'reader.progress.saved': 'Progress saved',
  'reader.progress': 'Progress',
  'pdf.rendering': 'Rendering PDF…',
  'mark.button': 'Highlight',
  'mark.drawer': 'Highlights & notes',
  'mark.count': 'items',
  'mark.empty': 'Select text in the reader to highlight; saved marks collect here.',
  'mark.delete': 'Delete',
  'mark.notePlaceholder': 'Write a note for this passage… (optional)',
  'mark.saved': 'Highlighted',
  'mark.tooLong': 'Selection too long, please shorten it',
  'mark.jump': 'Go to',
  'highlight.create': 'Highlight',
  'highlight.delete': 'Delete',
  'highlight.note.placeholder': 'Write a note…',
  'highlight.empty': 'No highlights yet.',
  'error.load': 'Failed to load',
  // 网页书源
  'web.title': 'Add web source',
  'web.badge': 'Web',
  'web.form.placeholder': 'Paste a chapter or catalog page URL',
  'web.form.hint':
    'The catalog and chapter 1 are fetched first; the rest are fetched automatically. The result is a local book you can read and highlight normally.',
  'web.submit': 'Fetch',
  'web.submitting': 'Reading catalog…',
  'web.cancel': 'Cancel',
  'web.invalid': 'URL must start with http:// or https://',
  'web.progress': '{fetched} of {total} chapters downloaded',
  'web.progress.fetching': 'Fetching…',
  'web.progress.done': 'All fetched',
  'web.progress.stopped': 'Paused',
  'web.progress.errors': '{count} chapter(s) failed',
  'web.start': 'Fetch remaining',
  'web.stop': 'Pause',
  'web.resume': 'Resume',
  'web.close': 'Dismiss',
  'web.hint.partial': 'Some chapters are missing. Use "Fetch remaining" later, or read what has been fetched.',
  'web.hint.autofetch':
    'Opening a chapter that has not been downloaded fetches it automatically (a few seconds); downloaded chapters are readable offline.',
  // ── Mark creation failures ──
  'mark.failed.notReady': 'Mark failed: the body is not ready yet, please retry',
  'mark.failed.selectionLost': 'Mark failed: the selection was lost — select the text again and retry',
  'mark.failed.outOfFlow': 'Mark failed: the selection is outside the body text',
  'mark.failed.empty': 'Mark failed: the selection has no usable text',
};
