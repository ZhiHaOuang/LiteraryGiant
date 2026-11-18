import {timePresets} from './components/time-stacks.js'
import {statisticsRange} from './stat-period.js'
import {requestBooks, pollOverview} from './api.js'
import {Activity} from './activity.jsx'
import {ApiPanel} from './api-panel.jsx'
import {TeamPanels} from './team-panel.jsx'
import analyticsStyles from './analytics.css'
import {ShelfLocation} from './bookshelf.jsx'
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {Card, number} from './charts.jsx'
import {groupRows, pendingItems, localDay} from './global-data.js'
import {fetchOverviewBatch,rowsOfSnapshot,sessionsSnapshotOf,workspacesSnapshotOf,
  openSessionVia,deriveUsage} from './context-data.js'
import {pricesBookOf} from '../../dsh-context/src/client/modelPrices'
import priceSnapshot from 'lg-offline-prices'
const offlinePrices=pricesBookOf(priceSnapshot.providers)
const noRows=[]
import {makeOverviewUsage} from './usage'
import styles from './style.css'
import globalStyles from './global.css'

const bookPalette=['var(--lgd-accent,#d97757)','#6B8A6F','#bc9777','#91a98c']
const money = value => value == null ? '—' : '¥'+value.toLocaleString(undefined,{maximumFractionDigits:4})
const short = value => value == null ? '—' : new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value)
const total = (books,key) => books.reduce((sum,book)=>sum+(book[key]??0),0)

function Ranking({title, rows, empty, subtitle, ready, icon}) {
  const [all,setAll]=useState(false)
  return <Card icon={icon} title={title} meta={ready?number(rows.reduce((n,row)=>n+row.n,0)):'—'}>
    <small>{subtitle}</small>
    <div className="lgg-ranking">{(all?rows:rows.slice(0,5)).map(row=><details key={row.id??row.name}>
      <summary><span>{row.name}</span><b>{number(row.n)}</b></summary><small>{row.detail}</small>
    </details>)}{!rows.length&&<p className="lgg-empty">{empty}</p>}</div>
    {rows.length>5&&<button onClick={()=>setAll(!all)}>{all?'−':'+'} {rows.length}</button>}
  </Card>
}

export function GlobalDashboard({ctx, slotProps, onOpenBook, onManage, shelf, shelfLoading, onRefresh, onChangeRoot}) {
  const zh=ctx.locale.getLocale?.().active==='zh'
  const l=(cn,en)=>zh?cn:en
  const [books,setBooks]=useState([]), [errors,setErrors]=useState([]), [loading,setLoading]=useState(true)
  const [batch,setBatch]=useState(),[usageError,setUsageError]=useState(false),[refresh,setRefresh]=useState(0)
  const [period,setPeriod]=useState('7d'),[pickedDay,setPickedDay]=useState(null)
  const [metric,setMetric]=useState('tokens'),[filter,setFilter]=useState(null)
  const [query,setQuery]=useState(''),[sort,setSort]=useState('recent'),[allPending,setAllPending]=useState(false)
  const [allTasks,setAllTasks]=useState(false)
  const snapshot=sessionsSnapshotOf(slotProps), workspaces=workspacesSnapshotOf(slotProps)
  const rows=useMemo(()=>rowsOfSnapshot(snapshot,workspaces,batch),[snapshot,workspaces,batch])
  const range=useMemo(()=>pickedDay?{from:pickedDay,to:pickedDay}:statisticsRange(period,rows??[],Date.now()),[period,rows,pickedDay,refresh])
  const prices=offlinePrices
  const polling=useRef(null)
  useEffect(()=>{
    setLoading(true)
    if(shelfLoading)return
    const controller=new AbortController()
    ;(async()=>{
      try {
        const list=shelf.books, values=[], failures=[]
        // Limit concurrent book reads; summaries never write to the project.
        for(const item of list) {
          if(controller.signal.aborted)return
          try { if(item.error) throw Error(item.error); values.push(await requestBooks({action:'read',path:item.path},controller.signal)) }
          catch(error) { if(controller.signal.aborted)return; failures.push(`${item.name??item.path}: ${error.message}`) }
        }
        if(!controller.signal.aborted){setBooks(values);setErrors(failures)}
      } catch(error){if(!controller.signal.aborted)setErrors([error.message])}
      finally{if(!controller.signal.aborted)setLoading(false)}
    })()
    return ()=>controller.abort()
  },[shelf,shelfLoading])
  useEffect(()=>{
    const poll=pollOverview(fetchOverviewBatch,value=>{setBatch(value);setUsageError(false)},()=>setUsageError(true))
    polling.current=poll
    void poll.refresh()
    return ()=>{poll.dispose();polling.current=null}
  },[])
  const source=rows??noRows
  const attribution=useMemo(()=>groupRows(source,books),[source,books])
  const usage=useMemo(()=>deriveUsage(source,attribution.rowsByBook,range,prices,filter),
    [source,attribution,range.from,range.to,prices,filter])
  const {scoped,days,stats,kpisByBook,skills,tools,dayKeys,tasks}=usage
  const valid=dayKeys.length>0
  const available=rows!==null && batch!==undefined && !usageError
  const grouped=[...books.map(book=>({key:book.path,label:book.name})),{key:'unbound',label:l('全局 / 未归属','Global / Unassigned')}]
    .map(group=>({...group,value:metric==='tokens'?kpisByBook.get(group.key)?.tokens:kpisByBook.get(group.key)?.cost}))
  const donut=grouped.filter(group=>group.value>0), sum=donut.reduce((n,g)=>n+g.value,0)
  const currentBooks=books.filter(book=>filter===null||book.path===filter)
  const lastActivity=book=>attribution.lastActivity.get(book.path)
  const visibleBooks=currentBooks.filter(book=>book.name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='words'?b.words-a.words:sort==='name'?a.name.localeCompare(b.name):lastActivity(b)-lastActivity(a))
  const pending=pendingItems(currentBooks)
  const agents=usage.agents.map(({row,n,kpi})=>({id:row.id,name:row.title,n,
    detail:`${l('会话及子 Agent · 模型请求','Session & subagents · model requests')} · ${number(kpi.tokens)} tokens · ${money(kpi.cost)} ${l('估算','estimated')}`}))
  const words=total(books,'words'),accepted=total(books,'acceptedWords')
  const metrics=[
    [l('书籍数量','Books'),loading?'—':number(books.length),l('已登记作品','Registered books')],
    [l('正文字数','Manuscript words'),loading?'—':number(words),l('当前正文 · 不含候选','Current manuscript · excludes candidates')],
    ['Tokens Used',available&&valid?short(stats.tokens):'—',l('所选日期 · 已记录用量','Selected dates · recorded usage')],
    [l('API 区间费用','API cost in range'),available&&valid?money(stats.cost):'—',l('估算 · 已定价部分','Estimated · priced usage only')],
    [l('作品实际收入','Actual revenue'),'¥0',l('暂记 0 · 后续手动录入','Initially 0 · manual entry later')],
    [l('收益 / API 花费','Revenue / API cost'),available&&valid&&stats.cost>0?'0×':'—',l('收入暂记 0 · 区间费用','Revenue initially 0 · period cost')],
    [l('已采用字数','Accepted words'),loading?'—':number(accepted),l('当前正式正文','Current accepted manuscript')],
    [l('创作转化效率','Creative conversion'),'—',l('新增采用字数 / 元 · 待接入历史','Newly adopted words / ¥ · history pending')],
  ]
  const Usage=useMemo(()=>makeOverviewUsage({t:key=>({
    'ov.usage.title':l('最近 7 天','Last 7 Days'),
    'ov.usage.empty':l('所选日期暂无用量','No usage in this range'),
    'ov.usage.tokens':'Tokens','ov.usage.cost':l('费用（已定价模型）','Cost (price-mapped models only)'),
    'ov.usage.costTip':l('估算费用','Estimated cost'),
  })[key]??key,fmt:short}),[zh])
  let offset=0
  const format=value=>metric==='tokens'?short(value):money(value)
  const empty=l('暂无已记录数据','No recorded data')
  const time=value=>value?new Date(value).toLocaleString(zh?'zh-CN':'en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'
  return <main className="lgd-page lgg-page"><style>{styles}{globalStyles}{analyticsStyles}</style>
    <header className="lgd-header lgd-topbar" data-window-drag><h1>{l('全局 Dashboard','Global Dashboard')}</h1><div className="lgd-header-actions">
      <div className="lgd-segment lgg-period" role="group" aria-label="Statistics time range" title={l('Agent 按精确时间统计；Context/API 按天汇总','Exact timestamps for Agents; daily totals for Context/API')}>{timePresets.map(([key,label])=><button key={key} aria-pressed={!pickedDay&&period===key} onClick={()=>{setPeriod(key);setPickedDay(null)}}>{label}</button>)}</div>
    </div>
    </header><div className="lgd-canvas">
    {(filter!==null||pickedDay)&&<div className="lgg-filter-chips">{filter!==null&&<button onClick={()=>setFilter(null)}>{grouped.find(g=>g.key===filter)?.label} ×</button>}{pickedDay&&<button onClick={()=>setPickedDay(null)}>{pickedDay} ×</button>}</div>}
    {errors.length>0&&<div role="alert" className="lgd-error">{l('部分作品读取失败，汇总不完整：','Some books could not be read; totals are incomplete:')} {errors.join(' · ')}</div>}
    <ShelfLocation ctx={ctx} shelf={shelf} onChange={onChangeRoot} refreshAction={<button disabled={loading||shelfLoading} onClick={()=>{setRefresh(refresh+1);void polling.current?.refresh();void onRefresh()}}>{loading||shelfLoading?l('加载中…','Loading…'):l('刷新','Refresh')}</button>}/>
    <TeamPanels range={range} filter={filter} refresh={refresh} period={period}/>
    {usageError&&<p role="status" className="lgd-error">{l('Context 统计暂不可用','Context statistics unavailable')}</p>}
    {!valid&&<p role="alert" className="lgd-error">{l('请选择有效日期范围','Select a valid date range')}</p>}
    <div className="lgg-top-grid">
      <div className="lgd-metrics lgg-metrics">{metrics.map(([label,value,hint])=><div className="lgd-metric" key={label}><span title={label}>{label}</span><b>{value}</b><small title={hint}>{hint}</small></div>)}{Array.from({length:4},(_,i)=><div key={'empty-'+i} className="lgd-metric lgg-metric-placeholder" aria-hidden="true"/>)}</div>
      <div className="lgg-top-charts">
      <Usage days={available?days:{}} currency="cny" today={localDay()}/>
      <Card icon="database" title={l('各作品用量占比','Usage by book')} meta={<div className="lgd-segment">{['tokens','cost'].map(key=><button key={key} aria-pressed={metric===key} onClick={()=>setMetric(key)}>{key==='tokens'?'Tokens':l('费用','Cost')}</button>)}</div>}>
        <div className="lgd-composition"><div className="lgd-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="39" fill="none" stroke="var(--lgd-track)" strokeWidth="10"/>{available&&donut.map((group,i)=>{const share=group.value/sum*100,start=offset;offset+=share;return <circle key={group.key} cx="50" cy="50" r="39" pathLength="100" fill="none" stroke={bookPalette[i%bookPalette.length]} strokeWidth="10" strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-start} transform="rotate(-90 50 50)"/>})}</svg><div><b>{available&&(sum>0||metric==='tokens')?format(sum):'—'}</b><small>{metric==='tokens'?'Tokens':'CNY'}</small></div></div>
          <div className="lgg-shares">{donut.map((group,i)=><button key={group.key} aria-pressed={filter===group.key} onClick={()=>setFilter(filter===group.key?null:group.key)}><i className="lgd-dot" style={{background:bookPalette[i%bookPalette.length]}}/><span>{group.label}<small>{format(group.value)}</small></span><b>{(group.value/sum*100).toFixed(1)}%</b></button>)}{!donut.length&&<p className="lgd-muted">{empty}</p>}</div>
        </div>
      </Card>
      </div>
    </div>
    <Activity days={days} ready={available} l={l} onSelect={key=>setPickedDay(key)}/>
    <Card title={l('作品进度','Book progress')} meta={l('当前状态','Current status')}>
      <div className="lgg-table-controls"><input type="search" aria-label={l('搜索作品','Search books')} placeholder={l('搜索作品…','Search books…')} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={l('作品排序','Sort books')} value={sort} onChange={e=>setSort(e.target.value)}><option value="recent">{l('最近活动','Recent activity')}</option><option value="words">{l('正文字数','Manuscript words')}</option><option value="name">{l('作品名称','Book name')}</option></select></div>
      <div className="lgg-table-scroll"><table><thead><tr>{[l('作品','Book'),l('阶段','Stage'),l('有正文章节','Written chapters'),l('正文字数','Words'),l('已采用','Accepted'),l('区间费用 · 估算','Period cost · est.'),l('待审候选','Candidates'),l('最近活动','Last activity')].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{visibleBooks.map(book=><tr key={book.path}><td><button className="lgg-book-link" onClick={()=>onOpenBook(book.path)}>{book.name}</button></td><td title={l('尚无作者设置的作品阶段','No author-assigned stage yet')}>—</td><td>{book.written} / {book.chapters.length}</td><td>{number(book.words)}</td><td>{number(book.acceptedWords)}</td><td>{available&&valid?money(kpisByBook.get(book.path).cost):'—'}</td><td>{number(book.counts.candidates)}</td><td>{time(lastActivity(book))}</td></tr>)}</tbody></table></div>
      {!visibleBooks.length&&<p className="lgg-empty">{loading?l('正在读取作品…','Loading books…'):l('暂无匹配作品，请检查搜索条件或 Books 目录','No matching books. Check your search or Books folder.')}</p>}
    </Card>
    <div className="lgd-columns">
      <Card icon="review" title={l('需要你处理','Needs your attention')} meta={`${pending.length} ${l('章待审','chapters')}`}>
        {(allPending?pending:pending.slice(0,5)).map(item=><button className="lgg-task" key={item.key} onClick={()=>onOpenBook(item.book.path,item.chapter.id)}><span><strong>{item.chapter.title}</strong><small>{item.book.name} · {l('候选正文待审','Manuscript review')}</small></span><b>{item.count} ›</b></button>)}
        {!pending.length&&<p className="lgg-empty">{l('暂无待审正文','No manuscript awaiting review')}</p>}
        {pending.length>5&&<button onClick={()=>setAllPending(!allPending)}>{allPending?l('收起','Collapse'):l('查看全部','Show all')}</button>}
        <small>{l('本版汇总章节候选；方向选择、事实提案和冲突任务尚未合并','Chapter candidates shown; planning, fact proposals and conflicts are not yet included')}</small>
      </Card>
      <Card icon="clock" title={l('最近任务','Recent tasks')} meta={available?`${tasks.length}`:'—'}>
        {(allTasks?tasks:tasks.slice(0,5)).map(row=><button className="lgg-task" key={row.id} onClick={()=>openSessionVia(ctx,row.id)}><span><strong>{row.title}</strong><small>{attribution.bookByRow.get(row)?.name??l('全局 / 未归属','Global / Unassigned')} · {row.running?l('运行中','Running'):time(row.updatedAt)}</small></span><span>↗</span></button>)}
        {!tasks.length&&<p className="lgg-empty">{available?l('所选日期暂无会话活动','No session activity in this range'):l('等待会话状态','Waiting for session status')}</p>}
        {tasks.length>5&&<button onClick={()=>setAllTasks(!allTasks)}>{allTasks?l('收起','Collapse'):l('查看全部','Show all')}</button>}
      </Card>
    </div>
    <div className="lgg-three">
      <Ranking ready={available&&valid} title="Agent" icon="agent" rows={agents} empty={empty} subtitle={l('按会话及子 Agent 汇总模型请求次数','Model requests grouped by session and subagents')}/>
      <Ranking ready={available&&valid} title="Skill Loads" icon="skill" rows={skills.map(row=>({...row,detail:`${row.sessions} ${l('个会话','sessions')} · ${l('最近加载','Last loaded')} ${time(row.last)}`}))} empty={empty} subtitle={l('实际加载次数 · 所选日期','Actual loads · selected dates')}/>
      <Ranking ready={available&&valid} title="Tool Calls" icon="tool" rows={tools.map(row=>({...row,detail:`${row.sessions} ${l('个会话','sessions')} · ${time(row.last)}`}))} empty={empty} subtitle={l('实际调用次数 · 失败 / 耗时待接入','Actual calls · failure / duration breakdown pending')}/>
    </div>
    <ApiPanel rows={scoped} range={range} dayKeys={dayKeys} prices={prices} ready={available} l={l} refresh={refresh}/>
    <details className="lgg-data-note"><summary>{l('统计说明','About these statistics')}</summary><footer>{l('统计来源：dsh-context 0.82.1 与已登记作品。用量不含尚未关联的旧文学执行账本；费用使用本地价格快照（2026-09-27）估算，非账单。未采集信息显示 —。','Sources: dsh-context 0.82.1 and registered books. Usage excludes the unlinked legacy literary ledger; costs use a local price snapshot (2026-09-27), not invoices. Unavailable information is shown as —.')}</footer></details>
  </div></main>
}
