import React,{useEffect,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BookProgress} from '../src/book-progress.jsx'
import {requestBooks} from '../src/api.js'
import base from '../src/style.css'
import global from '../src/global.css'
function App(){
 const [shelf,setShelf]=useState({books:[],booksPath:''}),[books,setBooks]=useState([])
 async function refresh(){const next=await requestBooks({action:'shelf'});const rows=await Promise.all(next.books.map(async item=>({...await requestBooks({action:'read',path:item.path}),archived:item.archived})));setShelf(next);setBooks(rows)}
 useEffect(()=>{void refresh()},[])
 return <main className="lgd-page lgg-page" style={{padding:16,'--dsw-alias-label-primary':'#222','--dsw-alias-label-secondary':'#777','--dsw-alias-bg-layer-1':'white','--dsw-alias-border-l2':'#ddd','--dsw-alias-border-l3':'#ccc'}}><style>{base+global}</style><BookProgress books={books} shelf={shelf} l={(cn,en)=>en} onRefresh={refresh} onOpenBook={()=>{}} lastActivity={()=>0} time={()=>'—'} cost={()=>'—'}/></main>
}
createRoot(document.getElementById('root')).render(<App/>);
