import { useCallback, useEffect } from 'react'
import { missingRequiredTools } from '@shared/types'
import { Sidebar } from './components/Sidebar'
import { ProjectDetail } from './components/ProjectDetail'
import { SessionView } from './components/SessionView'
import { OrphanView } from './components/OrphanView'
import { SetupView } from './components/SetupView'
import { EmptyDetail } from './components/Placeholders'
import { MasterView } from './components/MasterView'
import { ErrorBanners } from './components/ErrorBanners'
import { useErrors, useSelection, useSnapshot } from './store'

export function App() {
  const snapshot = useSnapshot()
  const [selection, setSelection] = useSelection()
  const [errors, dismiss] = useErrors()

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

  // ⌘O adds a project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'o') {
        e.preventDefault()
        void window.sauron.addProjectDialog()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      <Sidebar snapshot={snapshot} selection={selection} onSelect={setSelection} />
      <main className="detail">
        <ErrorBanners errors={errors} onDismiss={dismiss} />
        {detail}
      </main>
    </div>
  )
}
