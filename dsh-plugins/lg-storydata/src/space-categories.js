import {storySectionLabels} from '../../lg-books/src/story-data/labels.js'

// The storage views use the Dashboard timeline palette, with three related
// tints to distinguish all nine file categories.
export const categories=[
  ['manuscript','Manuscript','#9d7bf5'],
  ['main','Main Dossiers','#f2c46d'],
  ['characters',storySectionLabels.people,'#81c1ba'],
  ['plot',storySectionLabels.plot,'#e9ac92'],
  ['setting',storySectionLabels.world,'#b7abde'],
  ['chats','Conversations','#5b8def'],
  ['archives','Story Archives','#74dcae'],
  ['database','Database','#e57bb8'],
  ['other','Other Files','#9ab8db'],
].map(([key,label,color])=>({key,label,color}))

export const emptyParts=()=>Object.fromEntries(categories.map(({key})=>[key,0]))
export const sumParts=parts=>Object.values(parts).reduce((sum,bytes)=>sum+bytes,0)
