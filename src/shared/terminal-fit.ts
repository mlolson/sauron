/** Pure resize decision for the embedded terminal, shared so it can be tested. */

export interface Grid {
  cols: number
  rows: number
}

/** The grid left behind by the last fit, and when that fit happened. */
export interface PreviousFit extends Grid {
  at: number
}

/** How long after a fit a proposal to undo it counts as oscillation rather than a real resize. */
export const SETTLE_MS = 400

/**
 * Whether a proposed grid should be applied.
 *
 * fit() writes the terminal's size, which resizes the element the ResizeObserver watches,
 * which proposes again. At most heights the second proposal matches what is already there and
 * the cycle ends. At certain heights the two disagree by a row and flip-flop forever, which is
 * what makes a terminal bounce until the window is resized to a height where it settles.
 * Refusing to return to the grid just left ends that, while the settle window keeps a genuine
 * resize back to an earlier size working.
 */
export function shouldFit(proposed: Grid | undefined, current: Grid, previous: PreviousFit | undefined, now: number): boolean {
  if (!proposed) return false
  const { cols, rows } = proposed
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return false
  if (cols === current.cols && rows === current.rows) return false
  if (previous && cols === previous.cols && rows === previous.rows && now - previous.at < SETTLE_MS) return false
  return true
}
