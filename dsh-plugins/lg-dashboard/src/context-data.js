import {kpisOf,aggregateDays,skillLoadsOf,tallyStatsOf} from '../../dsh-context/src/client/overview'
import {dateKeys} from './global-data.js'
import {recentSessions} from './roster-data.js'

export {fetchOverviewBatch,rowsOfSnapshot,sessionsSnapshotOf,workspacesSnapshotOf} from '../../dsh-context/src/client/overview'
export {openSessionVia} from '../../dsh-context/src/client/services'
export {estimateSessionCost} from '../../dsh-context/src/client/cost'

// Keep Context's aggregation semantics here; cards consume the computed values.
export function deriveUsage(rows, rowsByBook, range, prices, filter) {
  const keys=dateKeys(range.from,range.to)
  const valid=keys.length>0&&keys.at(-1)===range.to
  const scope={start:+new Date(range.from+'T00:00:00'),end:+new Date(range.to+'T23:59:59.999')}
  const scoped=filter===null?rows:rowsByBook.get(filter)??[]
  const kpisByBook=new Map([...rowsByBook].map(([path,members])=>[path,valid?kpisOf(members,prices,'cny',scope):null]))
  const stats=!valid?null:filter===null?kpisOf(rows,prices,'cny',scope):kpisByBook.get(filter)??kpisOf([],prices,'cny',scope)
  const agents=valid?scoped.map(row=>{
    const days=aggregateDays([row],prices,'cny')
    const n=keys.reduce((sum,key)=>sum+(days[key]?.requests??0),0)
    return {row,n,kpi:kpisOf([row],prices,'cny',scope)}
  }).filter(agent=>agent.n>0).sort((a,b)=>b.n-a.n):[]
  return {
    scoped,kpisByBook,stats,agents,dayKeys:valid?keys:[],tasks:recentSessions(scoped,scope),
    // Fixed-seven-day and Activity cards deliberately use all dates and books.
    days:aggregateDays(rows,prices,'cny'),
    skills:valid?skillLoadsOf(scoped,{scope,day:null}):[],
    tools:valid?tallyStatsOf(scoped,{scope,day:null,field:'tools'}):[],
  }
}
