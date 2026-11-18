// Synthetic render-only fixture; never written to an App ledger.
import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {makeOverviewUsage} from '../src/usage.tsx'
import styles from '../src/style.css'
import globalStyles from '../src/global.css'
const Usage=makeOverviewUsage({t:key=>({'ov.usage.title':'Last 7 Days','ov.usage.tokens':'Tokens','ov.usage.cost':'Cost','ov.usage.costTip':'Cost','ov.usage.empty':'No usage'}[key]??key),fmt:n=>String(n)})
const keys=Array.from({length:7},(_,i)=>'2026-11-'+String(6+i).padStart(2,'0'))
const initial=Object.fromEntries(keys.map((k,i)=>[k,{tokens:(i+1)*100,cost:i===2?null:(i+1)*.01}]))
function App(){const [days,setDays]=useState(initial);return <div className="lgd-page" style={{width:620,height:270,'--lgd-accent':'#d97757','--dsw-alias-bg-layer-1':'#fff','--dsw-alias-label-primary':'#222','--dsw-alias-label-secondary':'#777','--dsw-alias-border-l2':'#ddd'}}><style>{styles+globalStyles}</style><button onClick={()=>setDays({...days,[keys[6]]:{tokens:2000,cost:.8}})}>Change fixture</button><Usage days={days} currency="USD" today="2026-11-12"/></div>}
createRoot(document.getElementById('root')).render(<App/>);
