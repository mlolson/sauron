import { describe, expect, it } from 'vitest'
import { compactTime } from '../src/shared/time'

const now = new Date('2026-09-04T12:00:00Z').getTime()
const ago = (ms: number) => new Date(now - ms).toISOString()

describe('compactTime', () => {
  it('reads as now under a minute', () => {
    expect(compactTime(ago(0), now)).toBe('now')
    expect(compactTime(ago(59_000), now)).toBe('now')
  })

  it('steps through minutes, hours and days', () => {
    expect(compactTime(ago(60_000), now)).toBe('1m')
    expect(compactTime(ago(45 * 60_000), now)).toBe('45m')
    expect(compactTime(ago(60 * 60_000), now)).toBe('1h')
    expect(compactTime(ago(5 * 3600_000), now)).toBe('5h')
    expect(compactTime(ago(26 * 3600_000), now)).toBe('1d')
    expect(compactTime(ago(9 * 24 * 3600_000), now)).toBe('9d')
  })

  it('never shows a negative age, and tolerates a bad timestamp', () => {
    expect(compactTime(new Date(now + 60_000).toISOString(), now)).toBe('now')
    expect(compactTime('not a date', now)).toBe('')
  })
})
