import React from 'react'
export function StoryQuality({data}){
 if(!data)return null
 const {coverage:c,quality:q}=data
 return <details className="lgd-data-quality"><summary>资料覆盖与待核对 · 已登记 {c.registered_chapters} / {c.total_chapters} 章 · 候选 {q.candidate} 条</summary>
  <p>已确认 {q.confirmed} 条。已登记来源不代表完整提取；尚未整理的章节内容不会由系统补造。</p>
  <dl className="lgd-data-fields"><dt>未定位事件</dt><dd>{q.unplaced_events.length}</dd><dt>时间仍未知的状态</dt><dd>{q.unknown_state_time.length}</dd><dt>未评级人物档案</dt><dd>{q.unrated_characters.length}</dd><dt>阶段性身份判断</dt><dd>{q.scoped_roles.length}</dd><dt>来源／依赖待复核</dt><dd>{q.source_issues.length} / {q.dependency_issues.length}</dd></dl>
  {!!q.possible_duplicates.length&&<p>可能重复的档案：{q.possible_duplicates.map(x=>`${x.name}（${x.ids.length} 个记录）`).join('、')}。保留旧 ID 与历史，未自动删除或确认合并。</p>}
  <p>人物重要程度属于当前已读范围的分析判断。时间视图只显示有依据的部分顺序；状态有触发事件也不等于此后一直持续。</p>
 </details>
}
