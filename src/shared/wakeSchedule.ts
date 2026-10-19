const FIVE_HOURS = 5 * 60 * 60 * 1000

export function dailyWakeSlots(firstAt: number, from: number, count = 4): number[] {
  if (!Number.isFinite(firstAt) || firstAt <= 0 || !Number.isFinite(from)) return []
  const first = new Date(firstAt)
  const day = new Date(Math.max(firstAt, from))
  day.setDate(day.getDate() - 1)
  const slots: number[] = []
  for (let offset = 0; offset < 10 && slots.length < count + 4; offset++) {
    const anchor = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, first.getHours(), first.getMinutes())
    for (let slot = 0; slot < 4; slot++) {
      const at = anchor.getTime() + slot * FIVE_HOURS
      if (at >= firstAt && at >= from) slots.push(at)
    }
  }
  return [...new Set(slots)].sort((a, b) => a - b).slice(0, count)
}

export function localDateTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
