import React,{useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Companions} from '../src/team-roster.jsx'
import base from '../src/style.css'
import styles from '../src/team-panel.css'
const two=[['那么，你愿意和我一起逃亡吗？','这一路上，我们将不彼此抛弃，不彼此出卖，直到死亡的尽头。']]
const three=[[{speaker:'1',text:'心老白马瘦，不如恩怨休'},{speaker:'2',text:'愿诸君皆各具天命，不负此生'},{speaker:'3',text:'所谓英雄，不过疯子'}]]
const long=[[{speaker:'1',text:'在这个世界的某个角落必有着为你而生的人'},{speaker:'2',text:'当你站在悬崖尽头时也不要放弃希望，再多等待那么一秒钟，等着那个人一骑绝尘如狂风闪电般出现在你面前'},{speaker:'3',text:'你将跨上他的马背，即便他是被神明囚禁了一千年的魔鬼'}]]
function App(){const [scene,setScene]=useState(two);return <div className="lgd-page" style={{width:440,height:300,padding:10,display:'flex',flexDirection:'column','--lgd-accent':'#d97757','--dsw-alias-bg-layer-1':'#fff','--dsw-alias-label-primary':'#222','--dsw-alias-label-secondary':'#777','--dsw-alias-border-l3':'#ccc'}}><style>{base+styles}</style><button onClick={()=>setScene(three)}>Three speakers</button><button onClick={()=>setScene(long)}>Long dialogue</button><Companions playlist={scene}/></div>}
createRoot(document.getElementById('root')).render(<App/>);
