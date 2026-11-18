import {summarizeRequests} from './telemetry.js'
export const periods=['today','24h','7d','14d','30d','all']
const HOUR=3600000,DAY=24*HOUR
export function usageWindow(period,now=Date.now(),earliest){
 if(!periods.includes(period))throw Error('Invalid Agent usage period')
 let from
 if(period==='24h')from=now-DAY
 else if(['7d','14d','30d'].includes(period))from=now-Number.parseInt(period)*DAY
 else if(period==='all')from=Number.isFinite(earliest)?earliest:+new Date(new Date(now).setHours(0,0,0,0))
 else {const date=new Date(now);date.setHours(0,0,0,0);from=+date}
 return {from,to:now+1}
}
export function requestTimeline(rows,period,capacity,now=Date.now()){
 if(!Number.isInteger(capacity)||capacity<2||capacity>96)throw Error('Invalid Agent bucket count')
 const times=rows.map(r=>Date.parse(r.started)).filter(Number.isFinite)
 const window=usageWindow(period,now,times.length?times.reduce((a,b)=>Math.min(a,b),Infinity):undefined),span=Math.max(1,window.to-window.from)
 // Choose readable intervals, bounded by available columns. The edge bins may be partial.
 const intervals=[1,5,15,30,60,120,180,360,720,1440,2880,10080,20160,43200,86400,525600].map(n=>n*60000)
 const step=intervals.find(n=>Math.ceil(span/n)<=capacity)??Math.ceil(span/capacity)
 const groups=Array.from({length:Math.max(1,Math.ceil(span/step))},()=>[])
 for(const row of rows){const time=Date.parse(row.started);if(time>=window.from&&time<window.to)groups[Math.floor((time-window.from)/step)].push(row)}
 return {version:1,period,...window,step,buckets:groups.map((group,i)=>({from:window.from+i*step,to:Math.min(window.to,window.from+(i+1)*step),roles:summarizeRequests(group).roles}))}
}
