import { describe, expect, it } from 'vitest'
import { compareSessions, moveBefore } from '../src/shared/session-order'
import type { Session } from '../src/shared/types'

const session = (id: string, createdAt: string, sortIndex?: number): Session =>
  ({ id, projectId: 'p', tool: 'shell', kind: 'managed', displayName: id, tmuxName: null, cliSessionId: null,
     transcriptPath: null, workingDir: '/x', worktreePath: null, createdAt, lastActivityAt: createdAt,
     state: 'idle', stateSource: 'inferred', ...(sortIndex === undefined ? {} : { sortIndex }) })

describe('compareSessions', () => {
  it('honours a manual order', () => {
    const list = [session('c', '2026-01-01T00:00:00Z', 2), session('a', '2026-01-02T00:00:00Z', 0), session('b', '2026-01-03T00:00:00Z', 1)]
    expect([...list].sort(compareSessions).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('appends never-placed sessions after placed ones, oldest first', () => {
    const list = [session('new', '2026-02-01T00:00:00Z'), session('older-new', '2026-01-01T00:00:00Z'), session('placed', '2026-03-01T00:00:00Z', 5)]
    expect([...list].sort(compareSessions).map((s) => s.id)).toEqual(['placed', 'older-new', 'new'])
  })
})

describe('moveBefore', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an item before another', () => {
    expect(moveBefore(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveBefore(ids, 'a', 'c')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves to the end when there is no target', () => {
    expect(moveBefore(ids, 'a', null)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('leaves the list alone for a no-op or an unknown id', () => {
    expect(moveBefore(ids, 'b', 'b')).toEqual(ids)
    expect(moveBefore(ids, 'b', 'c')).toEqual(ids)
    expect(moveBefore(ids, 'zzz', 'a')).toEqual(ids)
    expect(moveBefore(ids, 'a', 'zzz')).toEqual(ids)
  })
})
