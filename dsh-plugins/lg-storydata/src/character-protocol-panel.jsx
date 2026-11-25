import React,{useMemo,useState} from 'react'
import catalog from '../../lg-books/src/story-data/catalog.json'
import {storyFieldLabels,storySectionLabels} from '../../lg-books/src/story-data/labels.js'
import {Modes,PanelHeader} from './usage-card.jsx'
import {ProtocolVocabulary} from './protocol-vocabulary.jsx'
import {plotGroups,environmentGroups} from './plot-environment-protocol.js'
import {protocolGuide} from './protocol-guide.js'

function guideText(group,facet){
  const [purpose,example]=protocolGuide[group]?.[facet]??[]
  return {purpose,example}
}

function characterVocabulary(groups){
  return groups.map(group=>({
    id:group.module,label:group.label,
    facets:group.facets.map(({id,label,vocabulary})=>({
      id,label,...guideText(group.module,id),note:vocabulary.startsWith('建议固定为')?'建议固定用词':null,
      terms:vocabulary.replace(/^建议固定为/u,'').split(/[、；]/u).map(term=>term.trim()).filter(Boolean)
    }))
  }))
}

// Keep the actual record fields available alongside the literary guides.
function recordFields(id,label,types){
  return {id,label,facets:types.map(type=>({
    id:type,label:catalog[type].label,...guideText(id,type),
    terms:catalog[type].fields.map(field=>storyFieldLabels[field]??field)
  }))}
}
const records={
  plot:[...plotGroups,recordFields('plot','情节资料字段',['event','thread','revelation','plan','analysis','requirement'])],
  world:[...environmentGroups,recordFields('world','环境资料字段',['world_rule','entity','scene'])]
}
const views=Object.entries(storySectionLabels)
const layouts=[['compact','Compact'],['extend','Extend']]

export function InformationProtocolPanel({protocol}){
  const [view,setView]=useState('people')
  const [layout,setLayout]=useState('extend')
  const people=useMemo(()=>characterVocabulary(protocol.groups),[protocol.groups])
  const sections=views.map(([id,label])=>({id,label,groups:id==='people'?people:records[id]}))
  function openSection(id){
    setView(id)
    setLayout('extend')
  }
  return <section className="lg-protocol lg-space-card" aria-label="Information Protocol">
    <PanelHeader title="Information Protocol">
      <div className="lg-space-controls">
        {layout==='extend'&&<Modes name="Protocol View" items={views} value={view} onChange={setView}/>}
        <Modes name="Protocol Layout" items={layouts} value={layout} onChange={setLayout}/>
      </div>
    </PanelHeader>
    <ProtocolVocabulary sections={sections} view={view} layout={layout} onExtend={openSection}/>
  </section>
}
