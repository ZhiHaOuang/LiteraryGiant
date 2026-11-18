// Visual preview only: never included in monitoring totals or written to storage.
export function previewUsageDays(dayKeys,role){
 const seed=['coordinator','analysis','planning','writing'].indexOf(role)+1
 return Object.fromEntries(dayKeys.map((day,i)=>{
  const requests=2+(i*7+seed*3)%13
  return [day,{requests,tokens:requests*(350+(i*113+seed*239)%2100),known:requests}]
 }))
}

export function recentSessions(rows,{start,end}){
 return rows.filter(row=>row.running||(row.updatedAt>=start&&row.updatedAt<=end))
  .sort((a,b)=>Number(!!b.running)-Number(!!a.running)||(b.updatedAt||0)-(a.updatedAt||0)||String(a.id).localeCompare(String(b.id)))
}

export function sparkDays(days,dayKeys,width){
 const count=Math.max(3,Math.min(14,Math.floor(width/16)))
 return dayKeys.slice(-count).map(day=>({day,...(days?.[day]??{tokens:0,requests:0,known:0})}))
}
