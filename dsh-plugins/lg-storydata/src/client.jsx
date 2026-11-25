import React from 'react'
import {panelTitle,StoryDataConsole} from './console.jsx'

export const inject=['slots']
export function apply(ctx){
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'lg-storydata'},StoryDataConsole))
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({
    name:'sidebar.panellist',id:'lg-storydata',order:16,label:()=>panelTitle,
  },()=> <span aria-hidden="true">▦</span>))
}
