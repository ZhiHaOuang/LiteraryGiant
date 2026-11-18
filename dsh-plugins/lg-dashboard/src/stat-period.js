import {localDay} from './global-data.js'
const lookbackDays={today:0,'24h':1,'7d':7,'14d':14,'30d':30}
// Context Insights exposes daily totals; the Agent service retains exact timestamps.
export function statisticsRange(period,rows,now=Date.now()){
 const to=localDay(new Date(now))
 if(period!=='all')return {from:localDay(new Date(now-(lookbackDays[period]??7)*86400000)),to}
 let earliest
 for(const row of rows)for(const day of Object.keys(row.activity?.days??{})){
  if(/^\d{4}-\d{2}-\d{2}$/.test(day)&&(earliest===undefined||day<earliest))earliest=day
 }
 return {from:earliest??to,to}
}
