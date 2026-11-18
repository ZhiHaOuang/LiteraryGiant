const prominence={core:'核心人物',major:'重要人物',supporting:'配角',minor:'次要人物',unknown:'重要程度未定'}
const roles={protagonist:'主角',antagonist:'对抗者',mentor:'导师',ally:'伙伴',other:'其他角色'}
const unique=values=>[...new Set(values.filter(Boolean))]
export function characterRoleView(role){
 const assignments=role?.assignments??[]
 if(!assignments.length)return {label:'未评级',detail:'',scope:''}
 const scoped=role.status==='scoped'
 const selected=scoped?assignments:assignments.filter(r=>r.scope.kind==='book'&&!r.scope.targets.length&&r.story_time.kind==='all')
 const levels=unique(selected.map(r=>r.prominence)),scopes=unique(selected.map(r=>r.scope.description))
 const approvals=unique(selected.map(r=>r.approval)),roleNames=unique((scoped?selected.flatMap(r=>r.roles):role.roles??[]).map(r=>roles[r]??r))
 const approval=scoped?(approvals.length===1?(approvals[0]==='candidate'?'候选评级':'已确认评级'):'含候选与已确认评级'):(role.approval==='candidate'?'候选评级':role.approval==='confirmed'?'已确认评级':'')
 const prefix=selected.every(r=>r.scope.kind==='arc')?'阶段':'限定范围'
 const label=scoped?(levels.length===1?`${prefix} · ${prominence[levels[0]]??levels[0]}`:'多范围身份'):role.status==='conflict'?'评级待核对':role.status==='unrated'?'未评级':prominence[role.prominence]??'重要程度未定'
 return {label,detail:[approval,...roleNames].filter(Boolean).join(' · '),scope:scoped?(scopes.length===1?scopes[0]:`${scopes.length} 个限定范围，进入档案查看`):''}
}

export function previousLabel(type){return {knowledge:'此前认知',relation:'此前关系',state:'此前状态'}[type]??'前序记录'}
export function recordQualifier(record){
 if(record.type==='knowledge')return record.payload.topic?`认知主题：${record.payload.topic}`:'认知主题未登记'
 if(record.type==='revelation')return ({narration:'旁白披露',statement:'人物陈述',hint:'暗示',correction:'纠正先前信息',reveal:'揭晓'})[record.payload.presentation]??''
 return ''
}
