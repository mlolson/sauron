import { useState } from 'react'
import type { AgentDefinition, Project, SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { sameTarget } from '../store'
import { compactTime } from '@shared/time'
import { compareSessions, moveBefore } from '@shared/session-order'
import { StateDot } from './StateDot'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { RenameDialog } from './RenameDialog'
import { WorktreeDialog } from './WorktreeDialog'
import { JobDialog } from './JobDialog'
import type { BackgroundJob } from '@shared/types'
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
  const [forkingToWorktree, setForkingToWorktree] = useState<Session | null>(null)
  const [addingJobTo, setAddingJobTo] = useState<Project | null>(null)
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  // External sessions are background noise most of the time, so their group starts closed.
  const [expandedExternal, setExpandedExternal] = useState<Set<string>>(() => new Set())
  const [collapsed, setCollapsed] = useState(false)
  // Only the id being dragged and the row it is hovering; the order itself lives in the snapshot.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
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
      { label: 'Add background agent…', action: () => setAddingJobTo(project) } satisfies MenuItem,
      ...(project.backgroundJobs ?? []).filter((job) => job.enabled).map((job) => ({ label: `Run ${job.name}`, action: () => void window.sauron.runJob(project.id, job.id) } satisfies MenuItem)),
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
    const fork: MenuItem[] = forkable
      ? session.kind === 'external'
        ? [{ label: 'Import', action: () => void importExternalSession(session) }]
        : [
            { label: 'Fork', action: () => void window.sauron.forkSession(session.id) },
            { label: 'Fork to worktree…', action: () => setForkingToWorktree(session) },
          ]
      : []
    const handoff = handoffItems(snapshot.preferences.agents, snapshot.toolPaths?.agents ?? {}, session)
    if (session.kind === 'external') return [...fork, ...handoff, { label: 'Hide', action: () => void window.sauron.hideSession(session.id) }]
    if (isAlive(session)) {
      return [
        { label: 'Rename…', action: () => setRenaming(session) },
        ...(session.tmuxName ? [{ label: 'Copy attach cmd', action: () => window.sauron.copyToClipboard(`tmux attach -t ${session.tmuxName}`) } satisfies MenuItem] : []),
        ...fork,
        ...handoff,
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
      ...(session.background ? [] : [{ label: 'Resume', action: () => void window.sauron.resumeSession(session.id) } satisfies MenuItem]),
      ...fork,
      ...handoff,
      { label: 'Forget', destructive: true, action: () => void window.sauron.forgetSession(session.id) },
    ]
  }

  const unassigned = snapshot.sessions.filter((s) => s.projectId === null && s.id !== 'master')

  // Rendered in the toolbar when open and in a vertical rail when collapsed: the toolbar row
  // is where macOS draws the traffic lights, which would sit on top of a narrow strip's buttons.
  const toolbarButtons = (
    <>
      <button className="icon-button" title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
        {collapsed ? '»' : '«'}
      </button>
      <button className="icon-button" title="Add a git repository (⌘O)" onClick={() => void window.sauron.addProjectDialog()}>
        +
      </button>
      <button className="icon-button" title="Preferences (⌘,)" onClick={onOpenPreferences}>
        ⚙
      </button>
    </>
  )

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-toolbar">{!collapsed && toolbarButtons}</div>
      {collapsed && <div className="sidebar-rail">{toolbarButtons}</div>}
      <nav>
        {(() => {
          const master = snapshot.sessions.find((s) => s.id === 'master')
          const enabled = snapshot.preferences.supervisorEnabled
          const running = Boolean(master && isAlive(master))
          // The old menu offered Rename/Fork/Close, none of which the supervisor supports.
          // Summaries after a commit are the only refresh Sauron starts on its own; asking for
          // one by hand still works while paused.
          const summaries = snapshot.preferences.supervisorProjectSummaryAfterCommit
          const menu: MenuItem[] = enabled
            ? [
                { label: 'Restart', action: () => void window.sauron.restartMaster() },
                summaries
                  ? { label: 'Pause summaries', action: () => void window.sauron.setPreferences({ supervisorProjectSummaryAfterCommit: false }) }
                  : { label: 'Resume summaries', action: () => void window.sauron.setPreferences({ supervisorProjectSummaryAfterCommit: true }) },
                {
                  label: 'Disable',
                  destructive: true,
                  action: () => {
                    if (!running || confirm('Disable the supervisor agent?\n\nIt will be stopped, and project summaries will stop refreshing.')) {
                      void window.sauron.setPreferences({ supervisorEnabled: false })
                    }
                  },
                },
              ]
            : [{ label: 'Enable', action: () => void window.sauron.setPreferences({ supervisorEnabled: true }) }]
          return (
            <Row
              selected={sameTarget(selection, { kind: 'master' })}
              onClick={() => onSelect({ kind: 'master' })}
              onContextMenu={(e) => openMenu(e, menu)}
            >
              <span className={`glyph ${running ? 'accent' : 'muted'}`}>
                <ToolIcon tool={master?.tool ?? snapshot.preferences.supervisorAgentId} />
              </span>
              <span className={`label ${enabled ? '' : 'muted'}`}>
                <span className="name">Supervisor Agent</span>
                <span className="sub">
                  {!enabled ? 'disabled' : running ? (snapshot.refresh.inProgress ? 'refreshing a summary' : 'ready') : 'not running'}
                  {enabled && !summaries && ' · summaries paused'}
                </span>
              </span>
              {enabled && master && <StateDot state={master.state} />}
            </Row>
          )
        })()}

        <div className="section-title">Projects</div>
        {snapshot.projects.filter((project) => !project.archived).length === 0 && <div className="hint">Drop a git repository here or press ⌘O.</div>}
        {snapshot.projects.filter((project) => !project.archived).map((project) => {
          const collapsed = collapsedProjects.has(project.id)
          const all = snapshot.sessions.filter((s) => s.projectId === project.id)
          // Closed (resumable) sessions live on the project page, not in the sidebar.
          const managed = all.filter((s) => s.kind === 'managed' && isAlive(s)).sort(compareSessions)
          // Every external session, newest first; the group is collapsed, so length costs nothing.
          const externals = all.filter((s) => s.kind === 'external').sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
          const externalOpen = expandedExternal.has(project.id)
          const alive = managed.length
          const waiting = [...managed, ...externals].filter((s) => s.state === 'waitingForInput').length
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
              {!collapsed && managed.map((session) => (
                <Row
                  key={session.id}
                  nested
                  selected={sameTarget(selection, { kind: 'session', id: session.id })}
                  className={[
                    'draggable',
                    dragging === session.id ? 'dragging' : '',
                    dropBefore === session.id ? 'drop-before' : '',
                    dragging && dropBefore === null && session.id === managed.at(-1)?.id ? 'drop-last' : '',
                  ].filter(Boolean).join(' ')}
                  draggable
                  onDragStart={(e) => {
                    setDragging(session.id)
                    e.dataTransfer.effectAllowed = 'move'
                    // Some form of data is required for a drag to start at all in Chromium.
                    e.dataTransfer.setData('text/plain', session.id)
                  }}
                  onDragOver={(e) => {
                    if (!dragging || dragging === session.id) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    // Past the halfway mark the row being dragged belongs after this one.
                    const box = e.currentTarget.getBoundingClientRect()
                    const after = e.clientY > box.top + box.height / 2
                    const index = managed.findIndex((s) => s.id === session.id)
                    setDropBefore(after ? managed[index + 1]?.id ?? null : session.id)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragging) {
                      const order = moveBefore(managed.map((s) => s.id), dragging, dropBefore)
                      if (order.join() !== managed.map((s) => s.id).join()) void window.sauron.reorderSessions(project.id, order)
                    }
                    setDragging(null)
                    setDropBefore(null)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setDropBefore(null)
                  }}
                  onClick={() => onSelect({ kind: 'session', id: session.id })}
                  onContextMenu={(e) => openMenu(e, sessionMenu(session))}
                >
                  <span className={`glyph ${isAlive(session) ? 'accent' : 'muted'}`}>
                    <ToolIcon tool={session.tool} />
                  </span>
                  <span className={`label ${isAlive(session) ? '' : 'muted'}`}>
                    <span className="name">{session.displayName}</span>
                    {(session.background || session.worktreePath) && (
                      <span className="sub">{session.background ? `background run · ${branchOf(snapshot, session)}` : branchOf(snapshot, session)}</span>
                    )}
                  </span>
                  <span className="when" title={`Last active ${new Date(session.lastActivityAt).toLocaleString()}`}>{compactTime(session.lastActivityAt)}</span>
                  <StateDot state={session.state} />
                </Row>
              ))}
              {!collapsed && externals.length > 0 && (
                <>
                  <div
                    className="row nested external-group"
                    role="button"
                    tabIndex={0}
                    aria-expanded={externalOpen}
                    title="Sessions started outside Sauron"
                    onClick={() => setExpandedExternal((current) => {
                      const next = new Set(current)
                      if (next.has(project.id)) next.delete(project.id)
                      else next.add(project.id)
                      return next
                    })}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setExpandedExternal((current) => {
                        const next = new Set(current)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })
                    }}
                  >
                    <span className="glyph">{externalOpen ? '▾' : '▸'}</span>
                    <span className="label muted"><span className="name">External sessions</span></span>
                    <span className="badge">{externals.length}</span>
                  </div>
                  {externalOpen && externals.map((session) => (
                    <Row
                      key={session.id}
                      nested
                      deep
                      selected={sameTarget(selection, { kind: 'session', id: session.id })}
                      onClick={() => onSelect({ kind: 'session', id: session.id })}
                      onContextMenu={(e) => openMenu(e, sessionMenu(session))}
                    >
                      <span className="glyph external"><ToolIcon tool={session.tool} /></span>
                      <span className="label muted">
                        <span className="name">{session.displayName}</span>
                      </span>
                      <span className="when" title={`Last active ${new Date(session.lastActivityAt).toLocaleString()}`}>{compactTime(session.lastActivityAt)}</span>
                      <StateDot state={session.state} />
                    </Row>
                  ))}
                </>
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
                <span className="when" title={`Last active ${new Date(session.lastActivityAt).toLocaleString()}`}>{compactTime(session.lastActivityAt)}</span>
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
      {forkingToWorktree && (
        <WorktreeDialog
          title={`Fork ${forkingToWorktree.displayName} to a worktree`}
          action="Fork"
          onSubmit={(branch) => void window.sauron.forkSession(forkingToWorktree.id, { worktreeBranch: branch })}
          onClose={() => setForkingToWorktree(null)}
        />
      )}
      {addingJobTo && (
        <JobDialog
          agents={snapshot.preferences.agents}
          existing={null}
          taken={(addingJobTo.backgroundJobs ?? []).map((j) => j.id)}
          onSubmit={(job: BackgroundJob) => void window.sauron.saveProjectJobs(addingJobTo.id, [...(addingJobTo.backgroundJobs ?? []), job])}
          onClose={() => setAddingJobTo(null)}
        />
      )}
    </aside>
  )
}

function Row({
  children,
  selected,
  nested,
  deep,
  className = '',
  onClick,
  onContextMenu,
  ...drag
}: {
  children: React.ReactNode
  selected: boolean
  nested?: boolean
  deep?: boolean
  className?: string
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`row ${selected ? 'selected' : ''} ${nested ? 'nested' : ''} ${deep ? 'deep' : ''} ${className}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...drag}
    >
      {children}
    </div>
  )
}

/**
 * Brings an external session under Sauron by forking it, then says what that means: the new
 * session is a copy, the original is untouched, and the two will drift apart from here.
 */
export async function importExternalSession(session: Session): Promise<void> {
  const created = await window.sauron.forkSession(session.id)
  if (!created) return
  alert(
    `${created.displayName} has been imported into Sauron.\n\n` +
    'A managed session is now continuing a copy of the conversation, with Sauron\'s hooks and commit attribution. ' +
    'The original session was not changed and is still running in your terminal; from here the two conversations are independent.\n\n' +
    'You can hide the original from the External sessions group when you no longer need it.',
  )
}

/** One "Handoff to <agent>" item per other configured agent; greyed out when its binary is missing. */
export function handoffItems(agents: AgentDefinition[], found: Record<string, string | null>, session: Session): MenuItem[] {
  if (session.id === 'master') return []
  return agents
    .filter((agent) => agent.id !== session.tool)
    .map((agent) => ({ label: `Handoff to ${agent.name}`, disabled: !found[agent.id], action: () => void window.sauron.handoffSession(session.id, agent.id) }))
}

function branchOf(snapshot: Snapshot, session: Session): string {
  const wt = session.projectId ? snapshot.worktrees[session.projectId]?.find((w) => w.path === session.worktreePath) : undefined
  return wt?.branch ?? session.worktreePath?.split('/').pop() ?? ''
}

export function abbreviate(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0]
  return home ? path.replace(home, '~') : path
}
