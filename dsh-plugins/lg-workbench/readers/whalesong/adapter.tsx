// SPDX-License-Identifier: LGPL-3.0-or-later
// LG chapter bridge; ReaderPage and typography are unmodified Whalesong source.
import React, {useEffect, useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ReaderPage, PrefsControls, useReaderPrefs} from './upstream/src/client/reader/parts'

const t = (zh: string) => zh
type Chapter = {title: string; text: string; chapterId: string; bookTitle?: string; chapterIndex?: number}

function App() {
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [prefs, update] = useReaderPrefs()
  const scroller = useRef<HTMLDivElement>(null)
  const received = useRef<Chapter | null>(null)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'lg-reader:chapter') return
      const value = event.data
      if (typeof value.text !== 'string' || typeof value.title !== 'string' || typeof value.chapterId !== 'string') return
      if(received.current?.chapterId === value.chapterId && received.current?.text === value.text && received.current?.title === value.title) return
      const next = {title:value.title,text:value.text,chapterId:value.chapterId,
        bookTitle:typeof value.bookTitle === 'string' ? value.bookTitle : undefined,
        chapterIndex:Number.isInteger(value.chapterIndex) && value.chapterIndex > 0 ? value.chapterIndex : undefined}
      received.current = next
      setChapter(next)
      if(scroller.current) scroller.current.scrollTop = 0
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({type:'lg-reader:ready'}, '*')
    return () => window.removeEventListener('message', receive)
  }, [])
  return <div className="nv-root nv-standalone">
    <div className={`nv-reader ${prefs.theme === 'paper' ? 'is-paper' : prefs.theme === 'night' ? 'is-night' : ''}`}>
      <header className="nv-reader-bar">
        <strong className="nv-reader-label">鲸歌工坊</strong>
        <span className="nv-spacer"/>
        <div className="lg-reading-prefs"><PrefsControls prefs={prefs} update={update} t={t}/></div>
      </header>
      {chapter ? <div className={`lg-chapter-frame ${chapter.chapterIndex === undefined ? 'without-index' : ''}`}>
        <ReaderPage key={chapter.chapterId} t={t} bookTitle={chapter.bookTitle ?? 'LiteraryGiant'}
          chapter={{index:chapter.chapterIndex ?? 1,title:chapter.title}} text={chapter.text}
          prefs={prefs} media={() => 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='} scroller={scroller}/>
      </div> : <div className="nv-center">请选择一个章节</div>}
    </div>
  </div>
}
createRoot(document.getElementById('app')!).render(<App/>);
