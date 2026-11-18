export function lruTouch<K, T>(map: Map<K, T>, key: K): void {
  const known = map.get(key)
  if (known === undefined) return
  map.delete(key)
  map.set(key, known)
}

export function lruTrim<K, T>(map: Map<K, T>, max: number): void {
  let excess = map.size - max
  if (excess <= 0) return
  for (const key of map.keys()) {
    if (excess <= 0) break
    map.delete(key)
    excess--
  }
}
