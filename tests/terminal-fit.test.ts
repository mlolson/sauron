import { describe, expect, it } from 'vitest'
import { shouldFit, SETTLE_MS, type PreviousFit } from '../src/shared/terminal-fit'

const now = 1_000_000
const current = { cols: 100, rows: 40 }

describe('shouldFit', () => {
  it('applies a genuine change', () => {
    expect(shouldFit({ cols: 100, rows: 41 }, current, undefined, now)).toBe(true)
    expect(shouldFit({ cols: 120, rows: 40 }, current, undefined, now)).toBe(true)
  })

  it('skips a proposal that matches the current grid', () => {
    expect(shouldFit({ cols: 100, rows: 40 }, current, undefined, now)).toBe(false)
  })

  it('refuses to undo the fit it just made, which is the bounce', () => {
    // Just resized 41 -> 40 rows; a proposal to go straight back is the oscillation.
    const previous: PreviousFit = { cols: 100, rows: 41, at: now - 10 }
    expect(shouldFit({ cols: 100, rows: 41 }, current, previous, now)).toBe(false)
  })

  it('allows a real resize back to an earlier size once things have settled', () => {
    const previous: PreviousFit = { cols: 100, rows: 41, at: now - SETTLE_MS - 1 }
    expect(shouldFit({ cols: 100, rows: 41 }, current, previous, now)).toBe(true)
  })

  it('ignores missing or nonsensical proposals', () => {
    expect(shouldFit(undefined, current, undefined, now)).toBe(false)
    expect(shouldFit({ cols: Number.NaN, rows: 40 }, current, undefined, now)).toBe(false)
    expect(shouldFit({ cols: 1, rows: 40 }, current, undefined, now)).toBe(false)
    expect(shouldFit({ cols: 100, rows: 0 }, current, undefined, now)).toBe(false)
  })
})
