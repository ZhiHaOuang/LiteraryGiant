import React,{useLayoutEffect,useMemo,useRef,useState} from 'react'
import {categories} from './space-categories.js'

const digits='0123456789'.split('')

// A fixed strip per decimal place lets the browser interrupt a roll when the
// pointer crosses another segment before the previous transition finishes.
export function RollingShare({part,total}){
  const ratio=total?100*part/total:0
  const text=ratio>0&&ratio<0.1?'<0.1':ratio.toFixed(1)
  return <span className="lg-meter-roll" role="img" aria-label={text+'%'}>
    {Array.from(text+'%',(char,i)=>digits.includes(char)?
      <span className="lg-meter-wheel" key={text.length-i} aria-hidden="true">
        <span className="lg-meter-reel" style={{transform:'translateY(-'+char+'em)'}}>
          {digits.map(d=><span key={d}>{d}</span>)}
        </span>
      </span>:<span key={text.length-i} aria-hidden="true">{char}</span>)}
  </span>
}

export function StorageField({parts,total,highlight,onHover}){
  const field=useRef(null),[columns,setColumns]=useState(32)
  useLayoutEffect(()=>{
    const node=field.current
    const resize=()=>setColumns(Math.max(1,Math.round(node.clientWidth/8)))
    resize()
    const observer=new ResizeObserver(resize)
    observer.observe(node)
    return ()=>observer.disconnect()
  },[])
  // Round cumulative boundaries so the final band always ends at the last
  // dot. The headline and legend continue to use exact byte shares.
  const bands=useMemo(()=>{
    const count=columns*8
    let cumulative=0,start=0
    return (total?categories:[{key:'empty',color:'var(--line)'}]).map(category=>{
      cumulative+=parts[category.key]??0
      const end=total?Math.round(count*cumulative/total):count
      const dots=Array.from({length:end-start},(_,i)=><i key={start+i}/>)
      start=end
      return {...category,dots}
    })
  },[parts,total,columns])
  return <div ref={field} className="lg-space-field" aria-hidden="true"
    style={{gridTemplateColumns:'repeat('+columns+',minmax(0,1fr))'}} onPointerLeave={()=>onHover(null)}>
    {bands.filter(b=>b.dots.length).map(b=><span key={b.key} data-kind={b.key}
      style={{'--dot-color':b.color,'--dot-opacity':highlight&&highlight!==b.key?0.28:1}}
      onPointerEnter={()=>onHover(total?b.key:null)}>{b.dots}</span>)}
  </div>
}
