import { describe, expect, it } from 'vitest'
import { dailyWakeSlots } from './wakeSchedule'

describe('daily four-slot schedule', () => {
  const first = new Date(2026, 9, 20, 6, 0).getTime()
  it('follows 06 → 11 → 16 → 21 → next-day 06', () => {
    const slots = dailyWakeSlots(first, first, 5)
    expect(slots.map(at => new Date(at).getHours())).toEqual([6, 11, 16, 21, 6])
    expect(new Date(slots[4]).getDate()).toBe(21)
  })
  it('supports minute precision and never returns a slot before the initial anchor', () => {
    const half = first + 30 * 60 * 1000
    expect(dailyWakeSlots(half, first - 86400000, 4).map(at => new Date(at).getMinutes())).toEqual([30, 30, 30, 30])
    expect(dailyWakeSlots(half, first, 1)[0]).toBe(half)
  })
  it('keeps four slots per cycle when the anchor crosses midnight', () => {
    const late = new Date(2026, 9, 20, 21, 0).getTime()
    expect(dailyWakeSlots(late, late, 5).map(at => new Date(at).getHours())).toEqual([21, 2, 7, 12, 21])
  })
  it('rolls over missed slots without replaying all earlier requests', () => {
    expect(new Date(dailyWakeSlots(first, first + 36 * 3600000, 1)[0]).getHours()).toBe(21)
    expect(dailyWakeSlots(NaN, first)).toEqual([])
  })
})
