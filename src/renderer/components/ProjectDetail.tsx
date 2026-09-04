import { useEffect, useState } from 'react'
import type { KeyDocument, Preferences, Project, RecentCommit, SelectionTarget, Session, ToolPaths } from '@shared/types'
import { isAlive } from '@shared/types'
import type { Worktree } from '@shared/worktrees'
import type { ProjectStatus, RefreshState } from '@shared/status'
import { StateDot } from './StateDot'
import { abbreviate } from './Sidebar'
import { relativeTime } from '../time'
import { NewSessionBar } from './NewSessionBar'
import { ToolIcon } from './ToolIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { RenameDialog } from './RenameDialog'

interface Props {
  project: Project
  sessions: Session[]
  toolPaths: ToolPaths | null
  preferences: Preferences
  worktrees: Worktree[]
  status: ProjectStatus | undefined
  refresh: RefreshState
  masterAlive: boolean
  hiddenExternal: string[]
  documents: KeyDocument[]
  onSelect: (t: SelectionTarget) => void
}

export function ProjectDetail({ project, sessions, toolPaths, preferences, worktrees, status, refresh, masterAlive, hiddenExternal, documents, onSelect }: Props) {
  const refreshing = refresh.inProgress === project.id
  const queued = refresh.queued.includes(project.id)
  const [showHidden, setShowHidden] = useState(false)
  const [commits, setCommits] = useState<RecentCommit[] | null>(null)
  const [diff, setDiff] = useState<{ commit: RecentCommit; content: string | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<Session | null>(null)
  const managed = sessions.filter((s) => s.projectId === project.id && s.kind === 'managed')
  const mine = managed.filter(isAlive)
  const resumable = managed.filter((s) => !isAlive(s))
  const external = sessions
    .filter((s) => s.projectId === project.id && s.kind === 'external')
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))

  useEffect(() => {
    void window.sauron.refreshWorktrees(project.id)
    void window.sauron.refreshDocuments(project.id)
    setCommits(null)
    void window.sauron.recentCommits(project.id).then(setCommits)
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
  const viewDiff = async (commit: RecentCommit) => {
    setDiff({ commit, content: null })
    const content = await window.sauron.commitDiff(project.id, commit.hash)
    setDiff((current) => current?.commit.hash === commit.hash ? { commit, content } : current)
  }
  const sessionMenu = (session: Session): MenuItem[] => {
    const profile = preferences.agents.find((agent) => agent.id === session.tool)
    const forkable = Boolean(profile?.forkCommand?.length && session.cliSessionId)
    const common: MenuItem[] = [
      { label: 'Rename…', action: () => setRenaming(session) },
      ...(forkable ? [{ label: 'Fork', action: () => void window.sauron.forkSession(session.id) } satisfies MenuItem] : []),
    ]
    if (!isAlive(session)) return [...common, { label: 'Resume', action: () => void window.sauron.resumeSession(session.id) }, { label: 'Forget', destructive: true, action: () => void window.sauron.forgetSession(session.id) }]
    return [...common, {
      label: 'Close',
      destructive: true,
      action: () => {
        const keeps = session.tool !== 'shell' && session.cliSessionId
        if (keeps || confirm(`Close ${session.displayName}?\n\nThis kills the terminal. Plain terminals cannot be resumed.`)) void window.sauron.closeSession(session.id)
      },
    }]
  }
  const openSessionMenu = (event: React.MouseEvent, session: Session) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, items: sessionMenu(session) })
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
            <button className="link" title="Open this project in VS Code" onClick={() => void window.sauron.openInVsCode(project.path)}>
              Open in VS Code
            </button>
          </div>
        </div>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>Status</h2>
          <span className="muted small">
            {status ? `updated ${relativeTime(status.updatedAt)}` : ''}
            {refreshing ? ' · refreshing…' : queued ? ' · refresh queued' : ''}
          </span>
          <button
            disabled={refreshing || queued}
            title={masterAlive ? 'Ask the supervisor agent to rewrite this summary' : 'Start the supervisor agent first'}
            onClick={() => void window.sauron.refreshStatus(project.id)}
          >
            Refresh
          </button>
        </div>
        {status ? (
          <>
            <p className="summary">{status.summary}</p>
            <div className="status-columns">
              <div>
                <h3>Recent updates</h3>
                {status.recentUpdates.length ? (
                  <ul className="status-list">
                    {status.recentUpdates.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">None recorded.</p>
                )}
              </div>
              <div>
                <h3>TODOs</h3>
                {status.todos.length ? (
                  <ul className="status-list todos">
                    {status.todos.map((t, i) => (
                      <li key={i} className={/^blocked/i.test(t) ? 'blocked' : ''}>
                        {t}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">None recorded.</p>
                )}
              </div>
            </div>
            {status.details && <pre className="details">{status.details}</pre>}
          </>
        ) : (
          <p className="muted">{masterAlive ? 'No summary yet. Click Refresh to have the supervisor agent write one.' : 'No summary yet. Start the supervisor agent to generate one.'}</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Key Documents</h2>
          <span className="muted small">Markdown at the root or one level down, plus anything you add</span>
          <button onClick={() => void window.sauron.addKeyDocumentDialog(project.id)}>Add…</button>
        </div>
        {documents.length === 0 ? (
          <p className="muted">No documents found. Add one with the button above.</p>
        ) : (
          <ul className="doc-list">
            {documents.map((d) => (
              <li key={d.path}>
                <button className="doc" onClick={() => onSelect({ kind: 'document', projectId: project.id, path: d.path })} title={d.path}>
                  <span className="doc-icon">▤</span>
                  <span className="name">{d.name}</span>
                  {d.path.includes('/') && <span className="muted small">{d.path.slice(0, d.path.lastIndexOf('/'))}</span>}
                  {d.source === 'added' && <span className="tag">added</span>}
                </button>
                <span className="muted small">{relativeTime(d.mtime)}</span>
                <button className="link" title="Remove from key documents" onClick={() => void window.sauron.removeKeyDocument(project.id, d.path)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Sessions</h2>
        {project.archived ? <p className="muted">This project is archived. Unarchive it from the sidebar menu to start new sessions.</p> : <NewSessionBar project={project} toolPaths={toolPaths} preferences={preferences} />}
        {mine.length === 0 ? (
          <p className="muted">No sessions yet. Use New Terminal to start one.</p>
        ) : (
          <ul className="session-list">
            {mine.map((s) => (
              <li key={s.id} onClick={() => onSelect({ kind: 'session', id: s.id })} onContextMenu={(event) => openSessionMenu(event, s)}>
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

      {resumable.length > 0 && (
        <section className="card">
          <h2>Closed, resumable</h2>
          <ul className="session-list">
            {resumable.map((s) => (
              <li key={s.id} onContextMenu={(event) => openSessionMenu(event, s)}>
                <span className="glyph"><ToolIcon tool={s.tool} /></span>
                <span className="name">{s.displayName}</span>
                <span className="muted small">closed {relativeTime(s.lastActivityAt)}</span>
                <button onClick={() => void window.sauron.resumeSession(s.id)}>Resume</button>
                <button className="destructive" onClick={() => void window.sauron.forgetSession(s.id)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>External Sessions</h2>
          {hiddenExternal.length > 0 && (
            <button className="link" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? 'Hide hidden' : `${hiddenExternal.length} hidden`}
            </button>
          )}
        </div>
        {showHidden && hiddenExternal.length > 0 && (
          <ul className="session-list muted">
            {hiddenExternal.map((id) => (
              <li key={id}>
                <span className="name">{id.slice(0, 8)}</span>
                <button onClick={() => void window.sauron.unhideSession(id)}>Unhide</button>
              </li>
            ))}
          </ul>
        )}
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

      <section className="card">
        <div className="card-head">
          <h2>Recent commits</h2>
          <span className="muted small">Most recent 20 across local branches</span>
        </div>
        {commits === null ? <p className="muted">Loading commits…</p> : commits.length === 0 ? <p className="muted">No commits found.</p> : (
          <ul className="commit-list">
            {commits.map((commit) => (
              <li key={commit.hash}>
                <div className="commit-heading">
                  <strong>{commit.title}</strong>
                  {commit.branch && <span className="tag accent">{commit.branch}</span>}
                  <code className="commit-hash">{commit.shortHash}</code>
                </div>
                <div className="commit-message">{commit.message || <span className="muted">No additional message.</span>}</div>
                <div className="commit-attribution muted small">
                  <span>{commit.sessionName ? `Session: ${commit.sessionName}` : 'Session unknown'} · Git author: {commit.author} · {relativeTime(commit.authoredAt)}</span>
                </div>
                <div className="commit-actions">
                  <button onClick={() => void viewDiff(commit)}>View</button>
                  <CopyHashButton hash={commit.hash} />
                  {commit.sessionId && <button onClick={() => onSelect({ kind: 'session', id: commit.sessionId! })}>Go to session</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {diff && <DiffViewer commit={diff.commit} content={diff.content} onClose={() => setDiff(null)} onGoToSession={(sessionId) => { setDiff(null); onSelect({ kind: 'session', id: sessionId }) }} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {renaming && <RenameDialog initial={renaming.displayName} onSubmit={(title) => void window.sauron.renameSession(renaming.id, title)} onClose={() => setRenaming(null)} />}
    </div>
  )
}

function DiffViewer({ commit, content, onClose, onGoToSession }: { commit: RecentCommit; content: string | null; onClose: () => void; onGoToSession: (sessionId: string) => void }) {
  return (
    <div className="modal-backdrop diff-backdrop" onMouseDown={onClose}>
      <div className="diff-viewer" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div><strong>{commit.title}</strong><div className="muted small">{commit.shortHash} · {commit.author}</div></div>
          <div className="actions diff-viewer-actions">
            <CopyHashButton hash={commit.hash} />
            {commit.sessionId && <button onClick={() => onGoToSession(commit.sessionId!)}>Go to session</button>}
            <button onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="diff-content">
          {content === null ? <p className="muted">Loading diff…</p> : content ? content.split('\n').map((line, index) => <div key={index} className={`diff-line ${diffLineKind(line)}`}>{line || ' '}</div>) : <p className="muted">This commit has no textual diff.</p>}
        </div>
      </div>
    </div>
  )
}

function diffLineKind(line: string): string {
  if (line.startsWith('diff --git')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition'
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return 'meta'
  return ''
}

function CopyHashButton({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    window.sauron.copyToClipboard(hash)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <span className="copy-hash-wrap">
      <button onClick={copy}>Copy hash to clipboard</button>
      {copied && <span className="copy-tooltip" role="status">Copied</span>}
    </span>
  )
}
