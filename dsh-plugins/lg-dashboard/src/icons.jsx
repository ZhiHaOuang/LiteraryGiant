import React from 'react'
import {IconUserOutlineRegular,IconGlobeOutlineRegular,IconPlanOutlineRegular,IconFolderOpenOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import {IconData,IconDatabase,IconClock,IconGauge,IconBrowse,IconSkill,IconBranch,IconInspect,IconCheck} from '../../dsh-context/src/client/primitives'
const icons={person:IconUserOutlineRegular,world:IconGlobeOutlineRegular,plot:IconPlanOutlineRegular,folder:IconFolderOpenOutlineRegular,data:IconData,database:IconDatabase,clock:IconClock,gauge:IconGauge,book:IconBrowse,skill:IconSkill,tool:IconInspect,agent:IconBranch,review:IconCheck,IconCheck}
export function Icon({name='book',size=14}) {const Component=icons[name]??IconBrowse;return <Component size={size}/>}
