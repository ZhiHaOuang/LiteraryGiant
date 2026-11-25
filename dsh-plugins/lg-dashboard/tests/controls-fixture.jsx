import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Card,Composition} from '../src/charts.jsx'
import {BookTitle} from '../src/book-title.jsx'
import {ShelfLocation} from '../src/bookshelf.jsx'
import {BookProgress} from '../src/book-progress.jsx'
import en from '../locale/en.json'
import base from '../src/style.css'
import global from '../src/global.css'
import story from '../src/story-data.css'
import people from '../src/people-collection.css'
import team from '../src/team-panel.css'
const t=key=>en[key],l=(cn,en)=>en,shelf={booksPath:'/Example/Books',libraryPath:'/Example/Library'}
function Fixture(){
 const [metric,setMetric]=useState('Tokens'),[tab,setTab]=useState('人物简介'),[page,setPage]=useState(0)
 return <main className="lgd-page" style={{height:'auto',padding:12}}>
  <style>{base+global+story+people+team}</style>
  <Card title="Agent Statistics" meta={<div className="lgd-segment">{['Tokens','Context','Requests','Duration'].map(v=><button key={v} aria-pressed={metric===v} onClick={()=>setMetric(v)}>{v}</button>)}</div>}><output>{metric}</output></Card>
  <ShelfLocation ctx={{locale:{getLocale:()=>({active:'en'})}}} shelf={shelf} onChange={()=>{window.openedFolders=true}} refreshAction={<button>Refresh</button>}/>
  <Card title="Characters"><div className="lgd-section-head"><h3>罗兰（程岩）</h3><button>‹ 人物列表</button></div>
   <nav className="lgd-segment lgd-section-tabs">{['人物简介','性格与侧写','人物认知','人物状态','人物经历','人物关系'].map(v=><button key={v} aria-pressed={tab===v} onClick={()=>setTab(v)}>{v}</button>)}</nav>
   <button>查看修订历史</button><nav className="lgd-pager"><button disabled={!page} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / 3 · 13 条</span><button disabled={page===2} onClick={()=>setPage(page+1)}>下一页</button></nav>
  </Card>
  <Card title="Book Overview"><BookTitle book={{id:'test',name:'放开那个女巫 · 前 100 章续写实验',path:'/Example/Books/Example'}} t={t} onSaved={()=>{}}/></Card>
  <div className="comparison lgd-columns">
   {[t('manuscriptComposition'),t('chapterCoverage')].map(title=><Composition key={title} title={title} rows={[{label:'Manuscript',value:123}]} total={123} label="words" t={t}/>)}
  </div>
  <div className="lgg-page"><BookProgress books={[]} shelf={shelf} l={l} loading={false} onRefresh={()=>{}} lastActivity={()=>0}/></div>
 </main>
}
document.body.style.cssText='margin:0;--dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;--ds-font-family:var(--dsw-font-family);--dsw-alias-label-primary:#222;--dsw-alias-label-secondary:#777;--dsw-alias-bg-layer-1:white;--dsw-alias-border-l2:#ddd;--dsw-alias-border-l3:#ccc;--dsw-alias-border-l4:#ccc;--dsw-alias-bg-base:#f5f6f8'
createRoot(document.getElementById('root')).render(<Fixture/> )
