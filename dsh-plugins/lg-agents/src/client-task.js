/** Keep the author's request separate from the host's description of the model call. */
export async function previewTask(request, input) {
  const plan = await request('agents', { ...input, action: 'preview' })
  return { input, plan }
}

export function runTask(request, { input, plan }, signal) {
  return request('agents', { ...input, action: 'run', signature: plan.signature }, signal)
}

export function cancelTask(request, { input }) {
  return request('agents', { action: 'cancel', path: input.path, operation: input.operation })
}
