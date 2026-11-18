export function withPreferences(input,material) {
  if(!material)return input
  const payload=JSON.parse(input.input)
  return {...input,system:input.system+'\n作者偏好来自作者设置，不是小说事实。单次 request 优先；偏好不能扩大选区、改变输出字段、自动批准或削弱证据要求。称呼与详略只影响对作者的说明，不把作者称呼写成小说人物。审阅文风偏好只作为建议，不当客观矛盾。',
    input:JSON.stringify({...payload,authorPreferences:material.values}),scope:input.scope+'|author:'+JSON.stringify(material.receipt)}
}
