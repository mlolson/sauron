import { useEffect, useState } from 'react'
import type { BackgroundJob, JobRun, KeyDocument, Preferences, Project, RecentCommit, SelectionTarget, Session, SessionCommit, ToolPaths } from '@shared/types'
import { describeTrigger } from '@shared/jobs'
import { JobDialog } from './JobDialog'
import { CommitsPane } from './CommitsPane'
import { isAlive } from '@shared/types'
import type { Worktree } from '@shared/worktrees'
import type { ProjectStatus, RefreshState } from '@shared/status'
import { StateDot } from './StateDot'
import { abbreviate, handoffItems, importExternalSession } from './Sidebar'
import { compareSessions } from '@shared/session-order'
import { relativeTime } from '@shared/time'
import { NewSessionBar } from './NewSessionBar'
import { ToolIcon } from './ToolIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { RenameDialog } from './RenameDialog'
import { WorktreeDialog } from './WorktreeDialog'
import { CopyHashButton, DiffBody } from './CommitUI'

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
  runs: JobRun[]
  onSelect: (t: SelectionTarget) => void
}

export function ProjectDetail({ project, sessions, toolPaths, preferences, worktrees, status, refresh, masterAlive, hiddenExternal, documents, runs, onSelect }: Props) {
  const refreshing = refresh.inProgress === project.id
  const queued = refresh.queued.includes(project.id)
  const [showHidden, setShowHidden] = useState(false)
  const [commits, setCommits] = useState<RecentCommit[] | null>(null)
  const [sessionCommits, setSessionCommits] = useState<Record<string, SessionCommit>>({})
  const [diff, setDiff] = useState<{ commit: RecentCommit; content: string | null } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<Session | null>(null)
  const [forkingToWorktree, setForkingToWorktree] = useState<Session | null>(null)
  const [editingJob, setEditingJob] = useState<{ job: BackgroundJob | null } | null>(null)
  const [reviewing, setReviewing] = useState<JobRun | null>(null)
  const [logFor, setLogFor] = useState<{ run: JobRun; text: string | null } | null>(null)
  const jobs = project.backgroundJobs ?? []
  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? id
  const saveJob = (job: BackgroundJob) => {
    const next = jobs.some((j) => j.id === job.id) ? jobs.map((j) => (j.id === job.id ? job : j)) : [...jobs, job]
    void window.sauron.saveProjectJobs(project.id, next)
  }
  const removeJob = (job: BackgroundJob) => {
    if (confirm(`Remove the background agent "${job.name}"?\n\nPast runs and their branches are kept.`)) void window.sauron.saveProjectJobs(project.id, jobs.filter((j) => j.id !== job.id))
  }
  const mergeRun = (run: JobRun) => {
    if (confirm(`Merge "${jobName(run.jobId)}" into the current branch?\n\n${run.commitCount} commit(s) from ${run.branch}. The worktree and branch are removed afterwards.`)) void window.sauron.mergeRun(run.id)
  }
  const discardRun = (run: JobRun) => {
    if (confirm(`Discard this run of "${jobName(run.jobId)}"?\n\nIts branch and worktree are deleted. This cannot be undone.`)) void window.sauron.discardRun(run.id)
  }
  const showLog = async (run: JobRun) => {
    setLogFor({ run, text: null })
    const text = await window.sauron.runLog(run.id)
    setLogFor((cur) => (cur?.run.id === run.id ? { run, text } : cur))
  }
  const awaiting = runs.filter((r) => r.status === 'needs_review')
  const recent = runs.filter((r) => r.status !== 'needs_review').slice(0, 8)
  const managed = sessions.filter((s) => s.projectId === project.id && s.kind === 'managed')
  const mine = managed.filter(isAlive).sort(compareSessions)
  const resumable = managed.filter((s) => !isAlive(s))
  const external = sessions
    .filter((s) => s.projectId === project.id && s.kind === 'external')
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))

  useEffect(() => {
    void window.sauron.refreshWorktrees(project.id)
    void window.sauron.refreshDocuments(project.id)
    setCommits(null)
    void window.sauron.recentCommits(project.id).then(setCommits)
    setSessionCommits({})
    void window.sauron.lastCommitBySession(project.id).then(setSessionCommits)
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
      ...(forkable
        ? [
            { label: 'Fork', action: () => void window.sauron.forkSession(session.id) } satisfies MenuItem,
            { label: 'Fork to worktree…', action: () => setForkingToWorktree(session) } satisfies MenuItem,
          ]
        : []),
      ...handoffItems(preferences.agents, toolPaths?.agents ?? {}, session),
    ]
    if (!isAlive(session)) return [...common, { label: 'Resume', action: () => void window.sauron.resumeSession(session.id) }, { label: 'Forget', destructive: true, action: () => void window.sauron.forgetSession(session.id) }]
    const attach: MenuItem[] = session.tmuxName ? [{ label: 'Copy attach cmd', action: () => window.sauron.copyToClipboard(`tmux attach -t ${session.tmuxName}`) }] : []
    return [...common, ...attach, {
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
                  <span className="name-title">
                    {s.displayName}
                    {s.worktreePath && <span className="tag accent" style={{ marginLeft: 8 }}>{worktrees.find((w) => w.path === s.worktreePath)?.branch ?? 'worktree'}</span>}
                  </span>
                  <LastCommitLine commit={sessionCommits[s.id]} />
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
                <span className="name">
                  <span className="name-title">{s.displayName}</span>
                  <LastCommitLine commit={sessionCommits[s.id]} />
                </span>
                <span className="muted small">{s.background ? 'run finished' : 'closed'} {relativeTime(s.lastActivityAt)}</span>
                {!s.background && <button onClick={() => void window.sauron.resumeSession(s.id)}>Resume</button>}
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
            {external.slice(0, 30).map((s) => {
              const importable = Boolean(preferences.agents.find((agent) => agent.id === s.tool)?.forkCommand?.length && s.cliSessionId)
              return (
                <li key={s.id} onClick={() => onSelect({ kind: 'session', id: s.id })}>
                  <span className="glyph external"><ToolIcon tool={s.tool} /></span>
                  <span className="name">{s.displayName}</span>
                  <StateDot state={s.state} />
                  <span className="muted small">active {relativeTime(s.lastActivityAt)}</span>
                  {importable && (
                    <button
                      title="Bring this session under Sauron: a managed session continues a copy of the conversation. The original keeps running in your terminal."
                      onClick={(event) => {
                        // The row itself opens the session; the button must not also do that.
                        event.stopPropagation()
                        void importExternalSession(s)
                      }}
                    >
                      Import
                    </button>
                  )}
                </li>
              )
            })}
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
          <h2>Background agents</h2>
          <span className="muted small">Run headless in their own worktree; results land in Review</span>
          <button onClick={() => setEditingJob({ job: null })}>Add…</button>
        </div>
        {jobs.length === 0 ? (
          <p className="muted">None configured. Add one to run cleanups, reviews, or any prompt on this project without watching it.</p>
        ) : (
          <ul className="job-list">
            {jobs.map((job) => {
              const running = runs.some((r) => r.jobId === job.id && r.status === 'running')
              return (
                <li key={job.id} className={job.enabled ? '' : 'muted'}>
                  <span className="glyph"><ToolIcon tool={job.agentId} /></span>
                  <span className="name">
                    <span className="name-title">{job.name}{!job.enabled && <span className="tag" style={{ marginLeft: 8 }}>disabled</span>}</span>
                    <span className="muted small">{describeTrigger(job)} · {job.promptFile}</span>
                  </span>
                  <button disabled={!job.enabled || running} title={running ? 'A run is in progress' : 'Start a run now'} onClick={() => void window.sauron.runJob(project.id, job.id)}>
                    {running ? 'Running…' : 'Run now'}
                  </button>
                  <button onClick={() => setEditingJob({ job })}>Edit…</button>
                  <button className="destructive" onClick={() => removeJob(job)}>Remove</button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {(awaiting.length > 0 || recent.length > 0) && (
        <section className="card">
          <div className="card-head">
            <h2>Review</h2>
            <span className="muted small">{awaiting.length === 0 ? 'Nothing waiting' : `${awaiting.length} run${awaiting.length === 1 ? '' : 's'} waiting for a decision`}</span>
          </div>
          {awaiting.length > 0 && (
            <ul className="run-list">
              {awaiting.map((run) => (
                <li key={run.id}>
                  <div className="run-head">
                    <strong>{jobName(run.jobId)}</strong>
                    <span className="muted small">{run.commitCount} commit{run.commitCount === 1 ? '' : 's'} · finished {relativeTime(run.finishedAt ?? run.startedAt)} · <code>{run.branch}</code></span>
                  </div>
                  {run.summary && <p className="run-summary">{run.summary}</p>}
                  <div className="commit-actions">
                    <button className="primary" onClick={() => setReviewing(run)}>Review commits</button>
                    <button onClick={() => mergeRun(run)}>Merge</button>
                    <button onClick={() => void window.sauron.openRun(run.id)}>Open in session</button>
                    <button onClick={() => void showLog(run)}>Log</button>
                    <button className="destructive" onClick={() => discardRun(run)}>Discard</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <ul className="run-list recent">
              {recent.map((run) => (
                <li key={run.id}>
                  <div className="run-head">
                    <span className={`run-status ${run.status}`}>{run.status.replace('_', ' ')}</span>
                    <span>{jobName(run.jobId)}</span>
                    <span className="muted small">{run.status === 'running' ? `started ${relativeTime(run.startedAt)}` : relativeTime(run.finishedAt ?? run.startedAt)}</span>
                    {run.status === 'running' && <button onClick={() => onSelect({ kind: 'session', id: run.sessionId })}>Watch</button>}
                    {run.status !== 'running' && <button onClick={() => void showLog(run)}>Log</button>}
                  </div>
                  {run.status === 'failed' && run.summary && <p className="run-summary muted small">{run.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

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
      {forkingToWorktree && (
        <WorktreeDialog
          title={`Fork ${forkingToWorktree.displayName} to a worktree`}
          action="Fork"
          onSubmit={(branch) => void window.sauron.forkSession(forkingToWorktree.id, { worktreeBranch: branch })}
          onClose={() => setForkingToWorktree(null)}
        />
      )}
      {editingJob && (
        <JobDialog agents={preferences.agents} existing={editingJob.job} taken={jobs.map((j) => j.id)} onSubmit={saveJob} onClose={() => setEditingJob(null)} />
      )}
      {logFor && (
        <div className="modal-backdrop" onMouseDown={() => setLogFor(null)}>
          <div className="modal log-modal" onMouseDown={(e) => e.stopPropagation()}>
            <header><h2>{jobName(logFor.run.jobId)} · log</h2></header>
            <pre className="run-log">{logFor.text === null ? 'Loading…' : logFor.text || '(empty)'}</pre>
            <div className="actions right"><button onClick={() => setLogFor(null)}>Close</button></div>
          </div>
        </div>
      )}
      {reviewing && (() => {
        const session = sessions.find((s) => s.id === reviewing.sessionId)
        if (!session) return null
        return (
          <div className="review-pane">
            <CommitsPane
              session={session}
              projectId={project.id}
              initialBranch={reviewing.branch}
              onClose={() => setReviewing(null)}
              banner={
                <div className="review-banner">
                  <div>
                    <strong>{jobName(reviewing.jobId)}</strong>
                    <span className="muted small"> · {reviewing.commitCount} commit{reviewing.commitCount === 1 ? '' : 's'} on <code>{reviewing.branch}</code></span>
                    {reviewing.summary && <p className="run-summary">{reviewing.summary}</p>}
                  </div>
                  <div className="commit-actions">
                    <button className="primary" onClick={() => { mergeRun(reviewing); setReviewing(null) }}>Merge</button>
                    <button onClick={() => void window.sauron.openRun(reviewing.id)}>Open in session</button>
                    <button className="destructive" onClick={() => { discardRun(reviewing); setReviewing(null) }}>Discard</button>
                  </div>
                </div>
              }
            />
          </div>
        )
      })()}
    </div>
  )
}

/** The session's most recent commit, shown under its name. Absent until it makes one. */
function LastCommitLine({ commit }: { commit: SessionCommit | undefined }) {
  if (!commit) return null
  return (
    <span className="muted small last-commit" title={`${commit.shortHash} · ${new Date(commit.authoredAt).toLocaleString()}`}>
      <span className="last-commit-title">{commit.title}</span>
      <span className="last-commit-when">{commitTimestamp(commit.authoredAt)}</span>
    </span>
  )
}

/** Time of day for something committed today, otherwise the date as well. */
function commitTimestamp(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const sameDay = at.toDateString() === today.toDateString()
  return sameDay ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
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
          <DiffBody content={content} />
        </div>
      </div>
    </div>
  )
}

