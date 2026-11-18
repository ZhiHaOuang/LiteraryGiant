export async function requestBooks(input, signal) {
  const response = await fetch('api/lg/books', {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error ?? '请求失败')
  return result.value
}

// Context's snapshot reader has no cancellation parameter. Ignore disposed results;
// share an in-flight read with manual refresh and schedule only after it settles.
export function pollOverview(load, onValue, onError) {
  let stopped = false, pending, timer
  function refresh() {
    clearTimeout(timer)
    if (stopped) return
    if (pending) return pending
    pending = Promise.resolve().then(load)
      .then(value => { if (!stopped) onValue(value) }, error => { if (!stopped) onError(error) })
      .finally(() => {
        pending = undefined
        if (!stopped) timer = setTimeout(refresh, 30000)
      })
    return pending
  }
  return { refresh, dispose() { stopped = true; clearTimeout(timer) } }
}
