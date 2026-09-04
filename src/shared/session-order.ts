import type { Session } from './types'

/** Ordering for the managed sessions listed under a project, and the drag that rearranges them. */

/**
 * Manual order first, then oldest first for anything never placed by hand, so a session created
 * after a reorder appends rather than jumping to the top.
 */
export function compareSessions(a: Session, b: Session): number {
  const ai = a.sortIndex ?? Number.MAX_SAFE_INTEGER
  const bi = b.sortIndex ?? Number.MAX_SAFE_INTEGER
  if (ai !== bi) return ai - bi
  return a.createdAt.localeCompare(b.createdAt)
}

/**
 * The ids in `ordered` with `dragged` moved to sit before `target`, or last when target is null.
 * Returns the list unchanged when the move would be a no-op.
 */
export function moveBefore(ordered: string[], dragged: string, target: string | null): string[] {
  if (dragged === target) return ordered
  const without = ordered.filter((id) => id !== dragged)
  if (without.length === ordered.length) return ordered
  const at = target === null ? without.length : without.indexOf(target)
  if (at < 0) return ordered
  return [...without.slice(0, at), dragged, ...without.slice(at)]
}
