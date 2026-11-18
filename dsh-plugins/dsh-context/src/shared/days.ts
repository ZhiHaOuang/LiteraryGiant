export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

export const MONTH_KEY_RE = /^\d{4}-\d{2}$/

export function dayKeyOf(time: number): string | null {
  if (!Number.isFinite(time)) return null
  const d = new Date(time)
  const y = d.getFullYear()
  if (!Number.isFinite(y) || y < 1970 || y > 9999) return null
  return `${String(y).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateOfDayKey(key: string): Date | null {
  if (!DAY_KEY_RE.test(key)) return null
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  const d = Number(key.slice(8, 10))
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

export function shiftDayKey(key: string, delta: number): string | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setDate(date.getDate() + delta)
  return dayKeyOf(date.getTime())
}

export function weekdayOf(key: string): number | null {
  const date = dateOfDayKey(key)
  return date === null ? null : date.getDay()
}

export function sundayOfWeek(key: string): string | null {
  const weekday = weekdayOf(key)
  return weekday === null ? null : shiftDayKey(key, -weekday)
}

export function startOfDayKey(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function endOfDayKey(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

export function shiftMonthKey(month: string, delta: number): string | null {
  if (!MONTH_KEY_RE.test(month)) return null
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  if (index < 1 || index > 12) return null
  const total = year * 12 + (index - 1) + delta
  const y = Math.floor(total / 12)
  if (y < 1970 || y > 9999) return null
  return `${String(y).padStart(4, '0')}-${String(total - y * 12 + 1).padStart(2, '0')}`
}

export function monthGridOf(month: string): (string | null)[][] | null {
  const first = `${month}-01`
  const lead = weekdayOf(first)
  if (lead === null) return null
  const weeks: (string | null)[][] = []
  let week: (string | null)[] = []
  for (let i = 0; i < lead; i++) week.push(null)
  for (let day = 0; ; day++) {
    const key = shiftDayKey(first, day)
    if (key === null || key.slice(0, 7) !== month) {
      while (week.length < 7) week.push(null)
      weeks.push(week)
      return weeks
    }
    week.push(key)
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
}
