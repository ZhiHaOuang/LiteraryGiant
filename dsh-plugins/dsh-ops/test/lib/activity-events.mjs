/** DSH 0.2.0-rc.2 public event fixtures; no host or model calls. */
export const call = (seq, id = 'a', name = 'ops_grep', args = {}) => ({ type: 'tool/call', seq, time: seq * 10,
  data: { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) } })
export const result = (seq, id = 'a', value = {}, error) => ({ type: 'tool/result', seq, time: seq * 10,
  data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id },
    isError: error !== undefined, content: [{ type: 'text', text: JSON.stringify(value) }] }, ...(error ? { error } : {}) } })
export const dispatch = (seq, id, name = 'ops_glob', value, error) => ({
  type: value === undefined && error === undefined ? 'tool/ptc-dispatch-start' : 'tool/ptc-dispatch', seq, time: seq * 10,
  data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: id, name, arguments: {},
    ...(value === undefined && error === undefined ? {} : { isError: error !== undefined,
      content: [{ type: 'text', text: JSON.stringify(value ?? {}) }], ...(error ? { error } : {}) }) },
})
