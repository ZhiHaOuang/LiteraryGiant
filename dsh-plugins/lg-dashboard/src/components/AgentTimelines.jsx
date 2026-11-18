import React from 'react'
import {StackedBars} from './StackedBars'
import styles from './StackedBars.css'

// Summarizer is the sum of the four roles, not an additional Agent or request source.
export function AgentTimelines({timeline,onCapacity,unbound,mode='tokens'}){
 if(unbound)return <p className="lgd-muted">No Agent usage in this workspace.</p>
 if(timeline?.version!==1)return <p role="status" className="lgd-muted">监控后端尚未返回时间统计，请保存编辑后完整退出并重启 App。</p>
 return <div className="lgt-timeline-shell"><div className="lgt-time-groups" aria-label="Agent usage groups" data-mode={mode}><style>{styles}</style>
  <StackedBars mode={mode} title="Summarizer" groupRole="all" timeline={timeline} onCapacity={onCapacity} showScale/>
  <div className="lgt-member-timelines">
   {[['coordinator','Lead'],['analysis','Analysis'],['planning','Planning'],['writing','Writing']].map(([role,title])=><StackedBars mode={mode} key={role} title={title} groupRole={role} timeline={timeline}/>)}
  </div>
 </div></div>
}
