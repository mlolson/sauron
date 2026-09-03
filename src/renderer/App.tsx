import { useCallback, useEffect, useState } from 'react'
import { missingRequiredTools } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { ProjectDetail } from './components/ProjectDetail'
import { SessionView } from './components/SessionView'
import { OrphanView } from './components/OrphanView'
import { SetupView } from './components/SetupView'
import { EmptyDetail } from './components/Placeholders'
import { MasterView } from './components/MasterView'
import { PreferencesView } from './components/PreferencesView'
import { QuickSwitcher } from './components/QuickSwitcher'
import { isAlive } from '@shared/types'
import { ErrorBanners } from './components/ErrorBanners'
import { useErrors, useSelection, useSnapshot } from './store'

export function App() {
  const snapshot = useSnapshot()
  const [selection, setSelection] = useSelection()
  const [errors, dismiss] = useErrors()
  const [showPrefs, setShowPrefs] = useState(false)
  const [showSwitcher, setShowSwitcher] = useState(false)

  // Drop a folder anywhere on the window to add it.
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path ?? '')
      .filter(Boolean)
    if (paths.length) void window.sauron.addProjects(paths)
  }, [])
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), [])

  // Tell the main process which session is in front, so it can suppress redundant notifications.
  useEffect(() => {
    window.sauron.setActiveSession(selection?.kind === 'session' ? selection.id : null)
  }, [selection])

  // Keyboard: ⌘O add project, ⌘, preferences, ⌘K switcher, ⌘⇧] / ⌘⇧[ next and previous session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'o') {
        e.preventDefault()
        void window.sauron.addProjectDialog()
      } else if (e.key === ',') {
        e.preventDefault()
        setShowPrefs((v) => !v)
      } else if (e.key === 'k') {
        e.preventDefault()
        setShowSwitcher((v) => !v)
      } else if (e.shiftKey && (e.key === ']' || e.key === '[' || e.key === '}' || e.key === '{')) {
        e.preventDefault()
        const ordered = snapshot.sessions.filter((s) => s.kind === 'managed' && isAlive(s))
        if (ordered.length === 0) return
        const current = selection?.kind === 'session' ? ordered.findIndex((s) => s.id === selection.id) : selection?.kind === 'master' ? ordered.findIndex((s) => s.id === 'master') : -1
        const forward = e.key === ']' || e.key === '}'
        const next = ordered[(current + (forward ? 1 : ordered.length - 1) + ordered.length) % ordered.length]!
        setSelection(next.id === 'master' ? { kind: 'master' } : { kind: 'session', id: next.id })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snapshot, selection, setSelection])

  if (snapshot.toolPaths && missingRequiredTools(snapshot.toolPaths).length > 0) {
    return <SetupView toolPaths={snapshot.toolPaths} />
  }

  let detail: React.ReactNode
  switch (selection?.kind) {
    case 'project': {
      const project = snapshot.projects.find((p) => p.id === selection.id)
      detail = project ? (
        <ProjectDetail project={project} sessions={snapshot.sessions} toolPaths={snapshot.toolPaths} worktrees={snapshot.worktrees[project.id] ?? []} status={snapshot.statuses[project.id]} refresh={snapshot.refresh} masterAlive={snapshot.sessions.some((s) => s.id === 'master' && s.state !== 'stopped')} onSelect={setSelection} />
      ) : (
        <EmptyDetail />
      )
      break
    }
    case 'session': {
      const session = snapshot.sessions.find((s) => s.id === selection.id)
      detail = session ? (
        <SessionView key={session.id} session={session} snapshot={snapshot} onSelect={setSelection} />
      ) : (
        <EmptyDetail />
      )
      break
    }
    case 'orphan':
      detail = <OrphanView name={selection.name} onSelect={setSelection} />
      break
    case 'master': {
      const master = snapshot.sessions.find((s) => s.id === 'master')
      detail = master && master.state !== 'stopped' ? <SessionView key="master" session={master} snapshot={snapshot} onSelect={setSelection} /> : <MasterView session={master} />
      break
    }
    default:
      detail = <EmptyDetail />
  }

  return (
    <div className="app" onDrop={onDrop} onDragOver={onDragOver}>
      <Sidebar snapshot={snapshot} selection={selection} onSelect={setSelection} onOpenPreferences={() => setShowPrefs(true)} />
      <main className="detail">
        <ErrorBanners errors={errors} onDismiss={dismiss} />
        {detail}
      </main>
      {showPrefs && <PreferencesView preferences={snapshot.preferences} toolPaths={snapshot.toolPaths} onClose={() => setShowPrefs(false)} />}
      {showSwitcher && <QuickSwitcher snapshot={snapshot} onSelect={setSelection} onClose={() => setShowSwitcher(false)} />}
    </div>
  )
}
