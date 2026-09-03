import { useEffect } from 'react'
import type { Project, SelectionTarget, Session, ToolPaths } from '@shared/types'
import { isAlive } from '@shared/types'
import type { Worktree } from '@shared/worktrees'
import type { ProjectStatus, RefreshState } from '@shared/status'
import { StateDot } from './StateDot'
import { abbreviate } from './Sidebar'
import { relativeTime } from '../time'
import { NewSessionBar } from './NewSessionBar'
import { ToolIcon } from './ToolIcon'

interface Props {
  project: Project
  sessions: Session[]
  toolPaths: ToolPaths | null
  worktrees: Worktree[]
  status: ProjectStatus | undefined
  refresh: RefreshState
  masterAlive: boolean
  onSelect: (t: SelectionTarget) => void
}

export function ProjectDetail({ project, sessions, toolPaths, worktrees, status, refresh, masterAlive, onSelect }: Props) {
  const refreshing = refresh.inProgress === project.id
  const queued = refresh.queued.includes(project.id)
  const mine = sessions.filter((s) => s.projectId === project.id && s.kind === 'managed')
  const external = sessions
    .filter((s) => s.projectId === project.id && s.kind === 'external')
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))

  useEffect(() => {
    void window.sauron.refreshWorktrees(project.id)
  }, [project.id])

  const remove = async (wt: Worktree) => {
    const check = await window.sauron.checkWorktreeRemoval(project.id, wt.path)
    if (check.inUseBy.length) {
      alert(`This worktree is in use by ${check.inUseBy.join(', ')}. Stop those sessions first.`)
      return
    }
    const warnings: string[] = []
    if (check.dirty) warnings.push('it has uncommitted changes')
    if (check.unmergedCommits > 0) warnings.push(`its branch has ${check.unmergedCommits} commit(s) the main checkout does not`)
    const message = warnings.length
      ? `Remove worktree ${wt.branch ?? wt.path}?\n\nWarning: ${warnings.join(' and ')}. The branch is kept; only the directory is removed.`
      : `Remove worktree ${wt.branch ?? wt.path}?\n\nThe branch is kept; only the directory is removed.`
    // Errors surface as banners from the main process.
    if (confirm(message)) await window.sauron.removeWorktree(project.id, wt.path, check.dirty).catch(() => undefined)
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{project.name}</h1>
          <div className="path">
            <code>{abbreviate(project.path)}</code>
            <button className="link" title="Reveal in Finder" onClick={() => window.sauron.revealInFinder(project.path)}>
              ↗
            </button>
          </div>
        </div>
      </header>

      <NewSessionBar project={project} toolPaths={toolPaths} />

      <section className="card">
        <div className="card-head">
          <h2>Status</h2>
          <span className="muted small">
            {status ? `updated ${relativeTime(status.updatedAt)}` : ''}
            {refreshing ? ' · refreshing…' : queued ? ' · refresh queued' : ''}
          </span>
          <button
            disabled={refreshing || queued}
            title={masterAlive ? 'Ask the master agent to rewrite this summary' : 'Start the master agent first'}
            onClick={() => void window.sauron.refreshStatus(project.id)}
          >
            Refresh
          </button>
        </div>
        {status ? (
          <>
            <p className="summary">{status.summary}</p>
            {status.details && <pre className="details">{status.details}</pre>}
          </>
        ) : (
          <p className="muted">{masterAlive ? 'No summary yet. Click Refresh to have the master agent write one.' : 'No summary yet. Start the master agent to generate one.'}</p>
        )}
      </section>

      <section className="card">
        <h2>Sessions</h2>
        {mine.length === 0 ? (
          <p className="muted">No sessions yet. Use New Terminal to start one.</p>
        ) : (
          <ul className="session-list">
            {mine.map((s) => (
              <li key={s.id} onClick={() => onSelect({ kind: 'session', id: s.id })}>
                <span className="glyph"><ToolIcon tool={s.tool} /></span>
                <span className="name">
                  {s.displayName}
                  {s.worktreePath && <span className="tag accent" style={{ marginLeft: 8 }}>{worktrees.find((w) => w.path === s.worktreePath)?.branch ?? 'worktree'}</span>}
                </span>
                <StateDot state={s.state} />
                <span className="muted small">{relativeTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>External Sessions</h2>
        {external.length === 0 ? (
          <p className="muted">None found. Sessions started from a terminal in this directory appear here automatically.</p>
        ) : (
          <ul className="session-list">
            {external.slice(0, 30).map((s) => (
              <li key={s.id} onClick={() => onSelect({ kind: 'session', id: s.id })}>
                <span className="glyph external"><ToolIcon tool={s.tool} /></span>
                <span className="name">{s.displayName}</span>
                <StateDot state={s.state} />
                <span className="muted small">active {relativeTime(s.lastActivityAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Worktrees</h2>
        {worktrees.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="worktree-list">
            {worktrees.map((wt) => {
              const users = mine.filter((s) => s.worktreePath === wt.path && isAlive(s))
              return (
                <li key={wt.path}>
                  <span className="branch">{wt.branch ?? <span className="muted">(detached)</span>}</span>
                  <span className="path" title={wt.path}>{abbreviate(wt.path)}</span>
                  {wt.isMain && <span className="tag">main checkout</span>}
                  {wt.isSauron && <span className="tag accent">sauron</span>}
                  {users.length > 0 && <span className="tag">in use: {users.map((u) => u.displayName).join(', ')}</span>}
                  {!wt.isMain && (
                    <button className="destructive" disabled={users.length > 0} title={users.length ? 'Stop the sessions using it first' : 'Remove this worktree'} onClick={() => void remove(wt)}>
                      Remove
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
