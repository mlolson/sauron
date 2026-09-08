import { useEffect, useState } from 'react'
import type { AppError, SelectionTarget, Snapshot } from '@shared/types'
import { defaultPreferences } from '@shared/types'

const empty: Snapshot = { projects: [], sessions: [], orphanTmuxSessions: [], hiddenExternal: [], toolPaths: null, worktrees: {}, preferences: defaultPreferences, documents: {}, statuses: {}, runs: {}, schedulerLoaded: null,
  loaded: false }

export function useSnapshot(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty)
  useEffect(() => {
    let cancelled = false
    void window.sauron.getSnapshot().then((s) => {
      if (!cancelled) setSnapshot(s)
    })
    const off = window.sauron.onSnapshot(setSnapshot)
    return () => {
      cancelled = true
      off()
    }
  }, [])
  return snapshot
}

export function useSelection(): [SelectionTarget | null, (t: SelectionTarget | null) => void] {
  const [selection, setSelection] = useState<SelectionTarget | null>(null)
  useEffect(() => window.sauron.onSelect(setSelection), [])
  return [selection, setSelection]
}

export interface Banner extends AppError {
  id: number
}

export function useErrors(): [Banner[], (id: number) => void] {
  const [errors, setErrors] = useState<Banner[]>([])
  useEffect(
    () =>
      window.sauron.onError((e) => {
        setErrors((prev) => [...prev, { ...e, id: Date.now() + Math.random() }])
      }),
    [],
  )
  const dismiss = (id: number) => setErrors((prev) => prev.filter((e) => e.id !== id))
  return [errors, dismiss]
}

export function sameTarget(a: SelectionTarget | null, b: SelectionTarget | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'orphan' && b.kind === 'orphan') return a.name === b.name
  if (a.kind === 'document' && b.kind === 'document') return a.projectId === b.projectId && a.path === b.path
  if (a.kind === 'job' && b.kind === 'job') return a.projectId === b.projectId && a.jobId === b.jobId
  if ('id' in a && 'id' in b) return a.id === b.id
  return a.kind === 'master'
}
