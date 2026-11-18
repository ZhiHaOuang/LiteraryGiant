const NAME_COLORS = [
  'var(--color-blue-500)',
  'var(--color-green-500)',
  'var(--color-purple-500)',
  'var(--color-orange-500)',
  'var(--color-teal-500)',
  'var(--color-pink-500)',
  'var(--color-indigo-500)',
  'var(--color-amber-500)',
] as const

export function nameColorOf(name: string): string {
  let hash = 5381
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0
  return NAME_COLORS[hash % NAME_COLORS.length]
}
