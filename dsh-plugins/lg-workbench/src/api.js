export async function request(input, signal) {
  const response = await fetch('api/lg/books', { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error ?? '请求失败')
  return result.value
}

export async function reviewAcceptance(input) {
  const review = await request({...input, action:'acceptance-review'})
  if (!review || typeof review.reviewToken !== 'string' || !Object.hasOwn(review,'supervision'))
    throw new Error('未收到采用预览，请刷新后重试。')
  return review
}
