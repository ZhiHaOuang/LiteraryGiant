import React,{useEffect,useId,useRef,useState} from 'react'
import {categories} from './space-categories.js'

// Keep a group's colour when the catalog is reordered or the view changes.
const palette=Object.fromEntries(categories.map(({key,color})=>[key,color]))
const groupColors=Object.fromEntries([
  ['manuscript','core@1.identity','plot.causality','world.space'],
  ['main','core@1.goals','plot.time','world.material'],
  ['characters','core@1.personality','plot.disclosure','world.society'],
  ['plot','core@1.abilities','plot','world.rules'],
  ['setting','core@1.situation','world'],
  ['chats','core@1.knowledge','world.perception'],
  ['archives','core@1.relationships','plot.arcs'],
  ['database','core@1.milestones'],
].flatMap(([swatch,...ids])=>ids.map(id=>[id,palette[swatch]])))

function colorFor(group,index){
  return groupColors[group.id]??categories[index%categories.length].color
}

function ChoiceColumn({label,items,selected,onSelect,controls,swatches=false,hover=false,id}){
  const name=useId()
  return <div id={id} className="lg-protocol-choices" role="radiogroup" aria-label={label}>
    {items.map((item,index)=><label key={item.id} className="lg-protocol-choice"
      onPointerMove={hover?event=>{if(event.pointerType==='mouse'&&selected!==item.id)onSelect(item.id)}:undefined}>
      <input type="radio" name={name} checked={selected===item.id} aria-controls={controls}
        onChange={()=>onSelect(item.id)}/>
      {swatches&&<i aria-hidden="true" style={{backgroundColor:colorFor(item,index)}}/>}
      <span>{item.label}</span>
    </label>)}
  </div>
}

function FacetDetail({facet}){
  const {purpose,example}=facet
  return <div className="lg-protocol-copy">
    <h3>{facet.label}</h3>
    {purpose&&<p>{purpose}</p>}
    {facet.terms.length>0&&<div>
      <small>{facet.note??'词项'}</small>
      <ul aria-label="词项">{facet.terms.map(term=><li key={term}>{term}</li>)}</ul>
    </div>}
    {example&&<div><small>示例</small><p>{example}</p></div>}
  </div>
}

function CompactSection({section,onChoose}){
  const id=useId()
  return <div className="lg-protocol-index-section" role="group" aria-labelledby={id}>
    <h3 id={id} lang="en">{section.label}</h3>
    {section.groups.map((group,i)=><div className="lg-protocol-index-row" key={group.id} role="group"
      aria-labelledby={id+group.id} style={{'--protocol-group-color':colorFor(group,i)}}>
      <h4 id={id+group.id}><i aria-hidden="true"/>{group.label}</h4>
      <div className="lg-protocol-index-facets">{group.facets.map(facet=>
        <button type="button" key={facet.id} onClick={()=>onChoose(section.id,group.id,facet.id)}>{facet.label}</button>
      )}</div>
    </div>)}
  </div>
}

export function ProtocolVocabulary({sections,view,layout,onExtend}){
  const [groupByView,setGroupByView]=useState({})
  const [facetByGroup,setFacetByGroup]=useState({})
  const facetsId=useId(),detailId=useId()
  const detailRef=useRef(null),focusOnExtend=useRef(false)
  useEffect(()=>{
    if(layout==='extend'&&focusOnExtend.current){
      detailRef.current?.focus()
      focusOnExtend.current=false
    }
  },[layout])
  function selectGroup(viewId,id){setGroupByView(previous=>({...previous,[viewId]:id}))}
  function selectFacet(groupId,id){setFacetByGroup(previous=>({...previous,[groupId]:id}))}
  function openFacet(viewId,groupId,facetId){
    selectGroup(viewId,groupId)
    selectFacet(groupId,facetId)
    focusOnExtend.current=true
    onExtend(viewId)
  }
  if(layout==='compact')return <div className="lg-protocol-index" role="group" aria-label="分类总览" lang="zh-CN">
    {sections.map(section=><CompactSection key={section.id} section={section} onChoose={openFacet}/>)}
  </div>
  const groups=sections.find(section=>section.id===view).groups
  const group=groups.find(item=>item.id===groupByView[view])??groups[0]
  if(!group)return <p lang="zh-CN">暂无分类。</p>
  const facet=group.facets.find(item=>item.id===facetByGroup[group.id])??group.facets[0]
  return <div className="lg-protocol-browser" lang="zh-CN">
    <ChoiceColumn label="一级分类" items={groups} selected={group.id} controls={facetsId} swatches
      onSelect={id=>selectGroup(view,id)}/>
    <ChoiceColumn id={facetsId} label="二级分类" items={group.facets} selected={facet?.id} controls={detailId} hover
      onSelect={id=>selectFacet(group.id,id)}/>
    <div id={detailId} ref={detailRef} className="lg-protocol-detail" role="region" aria-label="细分说明" tabIndex={0}>
      {facet?<FacetDetail key={group.id+'/'+facet.id} facet={facet}/>:<p>暂无细分项。</p>}
    </div>
  </div>
}
