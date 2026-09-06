import { describe, expect, it } from 'vitest'
import { cronMatches, parseCron, previousFireTime } from '../src/shared/cron'

// Local-time dates, since cron schedules are read in local time.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0)

describe('parseCron', () => {
  it('reads stars, values, lists, ranges, steps and names', () => {
    const spec = parseCron('*/15 9-17 1,15 jan-mar mon-fri')
    expect([...spec.minute]).toEqual([0, 15, 30, 45])
    expect([...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...spec.dayOfMonth]).toEqual([1, 15])
    expect([...spec.month]).toEqual([1, 2, 3])
    expect([...spec.dayOfWeek]).toEqual([1, 2, 3, 4, 5])
  })

  it('treats 7 as Sunday and a bare value with a step as a range to the end', () => {
    expect([...parseCron('0 0 * * 7').dayOfWeek]).toEqual([0])
    expect([...parseCron('30/10 * * * *').minute]).toEqual([30, 40, 50])
  })

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/five fields/)
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/)
    expect(() => parseCron('5-1 * * * *')).toThrow(/Reversed/)
  })
})

describe('cronMatches', () => {
  it('applies the day-of-month / day-of-week OR rule', () => {
    const both = parseCron('0 0 13 * fri') // 13th, or any Friday
    expect(cronMatches(both, at(2026, 2, 13, 0, 0))).toBe(true) // Friday the 13th
    expect(cronMatches(both, at(2026, 3, 13, 0, 0))).toBe(true) // a Friday, 13th
    expect(cronMatches(both, at(2026, 3, 6, 0, 0))).toBe(true) // a Friday, not the 13th
    expect(cronMatches(both, at(2026, 4, 13, 0, 0))).toBe(true) // 13th, a Monday
    expect(cronMatches(both, at(2026, 4, 14, 0, 0))).toBe(false)
    const domOnly = parseCron('0 0 13 * *')
    expect(cronMatches(domOnly, at(2026, 3, 6, 0, 0))).toBe(false)
  })
})

describe('previousFireTime', () => {
  it('finds the most recent scheduled minute within the window', () => {
    const nightly = parseCron('0 3 * * *')
    expect(previousFireTime(nightly, at(2026, 9, 5, 9, 30), 24 * 60)).toEqual(at(2026, 9, 5, 3, 0))
    expect(previousFireTime(nightly, at(2026, 9, 5, 3, 0), 24 * 60)).toEqual(at(2026, 9, 5, 3, 0))
    expect(previousFireTime(nightly, at(2026, 9, 5, 2, 59), 24 * 60)).toEqual(at(2026, 9, 4, 3, 0))
    // Outside the window there is nothing to report.
    expect(previousFireTime(nightly, at(2026, 9, 5, 9, 30), 60)).toBeNull()
  })

  it('ignores seconds', () => {
    const every = parseCron('* * * * *')
    const now = new Date(2026, 8, 5, 12, 34, 56, 789)
    expect(previousFireTime(every, now, 5)).toEqual(new Date(2026, 8, 5, 12, 34, 0, 0))
  })
})
