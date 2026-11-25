import React from 'react'
import {createRoot} from 'react-dom/client'
import {Activity} from '../src/activity.jsx'
import {heatmapWindow} from '../src/api-data.js'
import {localDay} from '../src/global-data.js'
import base from '../src/style.css'
import analytics from '../src/analytics.css'
const days=Object.fromEntries(heatmapWindow().filter(key=>key<=localDay()).map((key,i)=>[key,{tokens:i%17*100,requests:i%5,sessions:i%3}]))
createRoot(document.getElementById('root')).render(<main className="lgd-page lgg-page" style={{padding:12,'--dsw-alias-label-primary':'#222','--dsw-alias-label-secondary':'#777','--dsw-alias-bg-layer-1':'white','--dsw-alias-border-l2':'#ddd','--dsw-alias-border-l3':'#ccc'}}><style>{base+analytics}</style><Activity days={days} ready l={(cn,en)=>cn} onSelect={key=>{window.selectedDay=key}}/></main>)
