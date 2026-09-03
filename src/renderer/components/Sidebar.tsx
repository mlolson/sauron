import { useState } from 'react'
import type { Project, SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { sameTarget } from '../store'
import { StateDot } from './StateDot'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface Props {
  snapshot: Snapshot
  selection: SelectionTarget | null
  onSelect: (t: SelectionTarget) => void
}

export function Sidebar({ snapshot, selection, onSelect }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const codexAvailable = Boolean(snapshot.toolPaths?.codex)
  const projectMenu = (project: Project): MenuItem[] => [
    { label: 'New Claude Session', action: () => void window.sauron.launchSession(project.id, 'claude') },
    { label: 'New Codex Session', disabled: !codexAvailable, action: () => void window.sauron.launchSession(project.id, 'codex') },
    { separator: true },
    { label: 'Reveal in Finder', action: () => window.sauron.revealInFinder(project.path) },
    { separator: true },
    {
      label: 'Remove from Sauron',
      destructive: true,
      action: () => {
        if (confirm(`Remove ${project.name} from Sauron?\n\nThe directory on disk is not touched.`)) {
          void window.sauron.removeProject(project.id)
        }
      },
    },
  ]

  const sessionMenu = (session: Session): MenuItem[] =>
    isAlive(session)
      ? [
          { label: 'Detach Terminal', action: () => void window.sauron.detachSession(session.id) },
          { label: 'Stop', destructive: true, action: () => void window.sauron.stopSession(session.id) },
        ]
      : [
          ...(session.cliSessionId ? [{ label: 'Resume', action: () => void window.sauron.resumeSession(session.id) }] : []),
          { label: 'Forget', destructive: true, action: () => void window.sauron.forgetSession(session.id) },
        ]

  const unassigned = snapshot.sessions.filter((s) => s.projectId === null)

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button className="icon-button" title="Add a git repository (⌘O)" onClick={() => void window.sauron.addProjectDialog()}>
          +
        </button>
      </div>
      <nav>
        <Row selected={sameTarget(selection, { kind: 'master' })} onClick={() => onSelect({ kind: 'master' })}>
          <span className="glyph">◉</span>
          <span className="label">Master Agent</span>
        </Row>

        <div className="section-title">Projects</div>
        {snapshot.projects.length === 0 && <div className="hint">Drop a git repository here or press ⌘O.</div>}
        {snapshot.projects.map((project) => {
          const sessions = snapshot.sessions.filter((s) => s.projectId === project.id)
          const alive = sessions.filter(isAlive).length
          return (
            <div key={project.id}>
              <Row
                selected={sameTarget(selection, { kind: 'project', id: project.id })}
                onClick={() => onSelect({ kind: 'project', id: project.id })}
                onContextMenu={(e) => openMenu(e, projectMenu(project))}
              >
                <span className="glyph">▸</span>
                <span className="label">
                  <span className="name">{project.name}</span>
                  <span className="sub">{abbreviate(project.path)}</span>
                </span>
                {alive > 0 && <span className="badge">{alive}</span>}
              </Row>
              {sessions.map((session) => (
                <Row
                  key={session.id}
                  nested
                  selected={sameTarget(selection, { kind: 'session', id: session.id })}
                  onClick={() => onSelect({ kind: 'session', id: session.id })}
                  onContextMenu={(e) => openMenu(e, sessionMenu(session))}
                >
                  <span className={`glyph ${isAlive(session) ? 'accent' : 'muted'}`}>{session.tool === 'claude' ? '✦' : '⌘'}</span>
                  <span className={`label ${isAlive(session) ? '' : 'muted'}`}>{session.displayName}</span>
                  <StateDot state={session.state} />
                </Row>
              ))}
            </div>
          )
        })}

        {unassigned.length > 0 && (
          <>
            <div className="section-title">Unassigned Sessions</div>
            {unassigned.map((session) => (
              <Row
                key={session.id}
                selected={sameTarget(selection, { kind: 'session', id: session.id })}
                onClick={() => onSelect({ kind: 'session', id: session.id })}
                onContextMenu={(e) => openMenu(e, sessionMenu(session))}
              >
                <span className="glyph">✦</span>
                <span className="label">{session.displayName}</span>
                <StateDot state={session.state} />
              </Row>
            ))}
          </>
        )}

        {snapshot.orphanTmuxSessions.length > 0 && (
          <>
            <div className="section-title">Unknown Sauron Sessions</div>
            {snapshot.orphanTmuxSessions.map((name) => (
              <Row key={name} selected={sameTarget(selection, { kind: 'orphan', name })} onClick={() => onSelect({ kind: 'orphan', name })}>
                <span className="glyph">?</span>
                <span className="label">{name}</span>
              </Row>
            ))}
          </>
        )}
      </nav>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  )
}

function Row({
  children,
  selected,
  nested,
  onClick,
  onContextMenu,
}: {
  children: React.ReactNode
  selected: boolean
  nested?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div className={`row ${selected ? 'selected' : ''} ${nested ? 'nested' : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      {children}
    </div>
  )
}

export function abbreviate(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0]
  return home ? path.replace(home, '~') : path
}
