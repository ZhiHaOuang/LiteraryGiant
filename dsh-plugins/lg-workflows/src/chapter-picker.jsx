import React from 'react'

export function ChapterPicker({chapters,items,change,carry,setCarry}){
  return <section><h3>章节顺序与要求</h3>
    <label>加入章节<select value="" disabled={items.length>=6} onChange={e=>change([...items,{document:Number(e.target.value),request:''}])}>
      <option value="" disabled>按起草顺序选择</option>{chapters.filter(c=>!items.some(item=>item.document===c.id)).map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
    <ol>{items.map(item=><li key={item.document}><label>{chapters.find(c=>c.id===item.document)?.title} · 本章要求
      <textarea maxLength={2000} value={item.request} onChange={e=>change(items.map(c=>c===item?{...c,request:e.target.value}:c))}/></label>
      <button onClick={()=>change(items.filter(c=>c!==item))}>移除本章</button></li>)}</ol>
    <label><input type="checkbox" checked={carry} onChange={e=>setCarry(e.target.checked)}/>将最近已采用章节的章末加入下一章</label>
  </section>
}
