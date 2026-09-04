import { useState } from 'react'
import type { Project, SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { sameTarget } from '../store'
import { StateDot } from './StateDot'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { RenameDialog } from './RenameDialog'
import { ToolIcon } from './ToolIcon'

interface Props {
  snapshot: Snapshot
  selection: SelectionTarget | null
  onSelect: (t: SelectionTarget) => void
  onOpenPreferences: () => void
}

export function Sidebar({ snapshot, selection, onSelect, onOpenPreferences }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<Session | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const agents = snapshot.preferences.agents
  const projectMenu = (project: Project): MenuItem[] => [
    ...(!project.archived ? [
      { label: 'New terminal', action: () => void window.sauron.launchSession(project.id, 'shell') } satisfies MenuItem,
      ...agents.map((agent) => ({ label: `New ${agent.name}`, disabled: !snapshot.toolPaths?.agents[agent.id], action: () => void window.sauron.launchSession(project.id, agent.id) } satisfies MenuItem)),
      { separator: true } satisfies MenuItem,
    ] : []),
    { label: 'Reveal in Finder', action: () => window.sauron.revealInFinder(project.path) },
    { separator: true },
    project.archived
      ? { label: 'Unarchive project', action: () => void window.sauron.archiveProject(project.id, false) }
      : {
          label: 'Archive project…',
          action: () => {
            if (confirm(`Archive ${project.name}?\n\nAll running sessions for this project will be closed.`)) void window.sauron.archiveProject(project.id, true)
          },
        },
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

  const sessionMenu = (session: Session): MenuItem[] => {
    const profile = snapshot.preferences.agents.find((agent) => agent.id === session.tool)
    const forkable = Boolean(profile?.forkCommand?.length && session.cliSessionId)
    const fork: MenuItem[] = forkable ? [{ label: 'Fork', action: () => void window.sauron.forkSession(session.id) }] : []
    if (session.kind === 'external') return [...fork, { label: 'Hide', action: () => void window.sauron.hideSession(session.id) }]
    if (isAlive(session)) {
      return [
        { label: 'Rename…', action: () => setRenaming(session) },
        ...fork,
        {
          label: 'Close',
          destructive: true,
          action: () => {
            const keeps = session.tool !== 'shell' && session.cliSessionId
            if (keeps || confirm(`Close ${session.displayName}?\n\nThis kills the terminal. Plain terminals cannot be resumed.`)) void window.sauron.closeSession(session.id)
          },
        },
      ]
    }
    return [
      { label: 'Rename…', action: () => setRenaming(session) },
      { label: 'Resume', action: () => void window.sauron.resumeSession(session.id) },
      ...fork,
      { label: 'Forget', destructive: true, action: () => void window.sauron.forgetSession(session.id) },
    ]
  }

  const unassigned = snapshot.sessions.filter((s) => s.projectId === null && s.id !== 'master')

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button
          className={`icon-button ${snapshot.preferences.notificationsMuted ? 'muted' : ''}`}
          title={snapshot.preferences.notificationsMuted ? 'Notifications are muted. Click to unmute.' : 'Notifications are on. Click to mute.'}
          onClick={() => void window.sauron.setPreferences({ notificationsMuted: !snapshot.preferences.notificationsMuted })}
        >
          {snapshot.preferences.notificationsMuted ? '🔕' : '🔔'}
        </button>
        <button className="icon-button" title="Add a git repository (⌘O)" onClick={() => void window.sauron.addProjectDialog()}>
          +
        </button>
        <button className="icon-button" title="Preferences (⌘,)" onClick={onOpenPreferences}>
          ⚙
        </button>
      </div>
      <nav>
        {(() => {
          const master = snapshot.sessions.find((s) => s.id === 'master')
          return (
            <Row selected={sameTarget(selection, { kind: 'master' })} onClick={() => onSelect({ kind: 'master' })} onContextMenu={master && isAlive(master) ? (e) => openMenu(e, sessionMenu(master)) : undefined}>
              <span className={`glyph ${master && isAlive(master) ? 'accent' : 'muted'}`}>
                <ToolIcon tool={master?.tool ?? snapshot.preferences.supervisorAgentId} />
              </span>
              <span className="label">
                <span className="name">Supervisor Agent</span>
                <span className="sub">{master && isAlive(master) ? (snapshot.refresh.inProgress ? 'refreshing a summary' : 'ready') : 'not running'}</span>
              </span>
              {master && <StateDot state={master.state} />}
            </Row>
          )
        })()}

        <div className="section-title">Projects</div>
        {snapshot.projects.filter((project) => !project.archived).length === 0 && <div className="hint">Drop a git repository here or press ⌘O.</div>}
        {snapshot.projects.filter((project) => !project.archived).map((project) => {
          const collapsed = collapsedProjects.has(project.id)
          const cutoff = Date.now() - snapshot.preferences.externalRecentHours * 3600_000
          const all = snapshot.sessions.filter((s) => s.projectId === project.id)
          // Closed (resumable) sessions live on the project page, not in the sidebar.
          const sessions = all.filter((s) => (s.kind === 'managed' ? isAlive(s) : new Date(s.lastActivityAt).getTime() >= cutoff))
          const olderExternal = all.filter((s) => s.kind === 'external').length - sessions.filter((s) => s.kind === 'external').length
          const alive = sessions.filter((s) => s.kind === 'managed' && isAlive(s)).length
          const waiting = sessions.filter((s) => s.state === 'waitingForInput').length
          return (
            <div key={project.id}>
              <Row
                selected={sameTarget(selection, { kind: 'project', id: project.id })}
                onClick={() => onSelect({ kind: 'project', id: project.id })}
                onContextMenu={(e) => openMenu(e, projectMenu(project))}
              >
                <button
                  className="glyph disclosure"
                  aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name} sessions`}
                  aria-expanded={!collapsed}
                  onClick={(event) => {
                    event.stopPropagation()
                    setCollapsedProjects((current) => {
                      const next = new Set(current)
                      if (next.has(project.id)) next.delete(project.id)
                      else next.add(project.id)
                      return next
                    })
                  }}
                >
                  {collapsed ? '▸' : '▾'}
                </button>
                <span className="label">
                  <span className="name">{project.name}</span>
                  <span className="sub" title={snapshot.statuses[project.id]?.summary}>{snapshot.statuses[project.id]?.summary ?? abbreviate(project.path)}</span>
                </span>
                {(snapshot.refresh.inProgress === project.id || snapshot.refresh.queued.includes(project.id)) && (
                  <span className="spinner" title={snapshot.refresh.inProgress === project.id ? 'Refreshing summary' : 'Refresh queued'} />
                )}
                {waiting > 0 && <span className="badge waiting" title="Sessions waiting for input">{waiting}</span>}
                {alive > 0 && <span className="badge">{alive}</span>}
              </Row>
              {!collapsed && sessions.map((session) => (
                <Row
                  key={session.id}
                  nested
                  selected={sameTarget(selection, { kind: 'session', id: session.id })}
                  onClick={() => onSelect({ kind: 'session', id: session.id })}
                  onContextMenu={(e) => openMenu(e, sessionMenu(session))}
                >
                  <span className={`glyph ${session.kind === 'external' ? 'external' : isAlive(session) ? 'accent' : 'muted'}`} title={session.kind === 'external' ? 'Started outside Sauron' : undefined}>
                    <ToolIcon tool={session.tool} />
                  </span>
                  <span className={`label ${isAlive(session) ? '' : 'muted'}`}>
                    <span className="name">{session.displayName}</span>
                    {session.worktreePath && <span className="sub">{branchOf(snapshot, session)}</span>}
                  </span>
                  <StateDot state={session.state} />
                </Row>
              ))}
              {!collapsed && olderExternal > 0 && (
                <div className="row nested hint-row" title="Older external sessions are listed in the project view">
                  <span className="glyph">…</span>
                  <span className="label muted">{olderExternal} older external</span>
                </div>
              )}
            </div>
          )
        })}

        {snapshot.projects.some((project) => project.archived) && (
          <>
            <div className="section-title archived-title" onClick={() => setArchivedCollapsed((value) => !value)}>
              <span>{archivedCollapsed ? '▸' : '▾'}</span> Archived
              <span className="badge">{snapshot.projects.filter((project) => project.archived).length}</span>
            </div>
            {!archivedCollapsed && snapshot.projects.filter((project) => project.archived).map((project) => (
              <Row
                key={project.id}
                selected={sameTarget(selection, { kind: 'project', id: project.id })}
                onClick={() => onSelect({ kind: 'project', id: project.id })}
                onContextMenu={(event) => openMenu(event, projectMenu(project))}
              >
                <span className="glyph muted">◇</span>
                <span className="label muted"><span className="name">{project.name}</span><span className="sub">{abbreviate(project.path)}</span></span>
              </Row>
            ))}
          </>
        )}

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
                <span className="glyph">
                  <ToolIcon tool={session.tool} />
                </span>
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
      {renaming && <RenameDialog initial={renaming.displayName} onSubmit={(t) => void window.sauron.renameSession(renaming.id, t)} onClose={() => setRenaming(null)} />}
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

function branchOf(snapshot: Snapshot, session: Session): string {
  const wt = session.projectId ? snapshot.worktrees[session.projectId]?.find((w) => w.path === session.worktreePath) : undefined
  return wt?.branch ?? session.worktreePath?.split('/').pop() ?? ''
}

export function abbreviate(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0]
  return home ? path.replace(home, '~') : path
}
