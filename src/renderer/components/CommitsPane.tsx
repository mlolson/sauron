import { useEffect, useState } from 'react'
import type { RecentCommit, Session } from '@shared/types'
import { relativeTime } from '../time'
import { CopyHashButton, DiffBody } from './CommitUI'
import { ToolIcon } from './ToolIcon'

type Scope = 'session' | 'all'

/**
 * Commits for a session, list on the left and the selected commit's diff on the right.
 * Defaults to this session's own commits, which is the view only Sauron can offer: the
 * attribution store is what knows which agent made which commit.
 */
export function CommitsPane({ session, projectId, onClose }: { session: Session; projectId: string; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>('session')
  // '' means every branch, which is what git log --all walks.
  const [branch, setBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [commits, setCommits] = useState<RecentCommit[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ hash: string; content: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setCommits(null)
    setSelected(null)
    setError(null)
    const load = scope === 'session' ? window.sauron.sessionCommits(session.id, branch || undefined) : window.sauron.recentCommits(projectId, 100, branch || undefined)
    void load
      .then((list) => {
        if (!current) return
        setCommits(list)
        setSelected(list[0]?.hash ?? null)
      })
      .catch((e: Error) => current && setError(e.message))
    return () => {
      current = false
    }
  }, [scope, branch, session.id, projectId])

  useEffect(() => {
    void window.sauron.projectBranches(projectId).then(setBranches)
  }, [projectId])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    setDiff({ hash: selected, content: null })
    void window.sauron
      .commitDiff(projectId, selected)
      // A later selection may have won the race; only the current one may write.
      .then((content) => setDiff((cur) => (cur?.hash === selected ? { hash: selected, content } : cur)))
      .catch((e: Error) => setDiff((cur) => (cur?.hash === selected ? { hash: selected, content: `Cannot read this commit: ${e.message}` } : cur)))
  }, [selected, projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = commits?.find((c) => c.hash === selected)

  return (
    <div className="commits-pane">
      <header className="session-header">
        <div className="segmented">
          <button className={scope === 'session' ? 'active' : ''} onClick={() => setScope('session')}>
            This session
          </button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
            All commits
          </button>
        </div>
        <div className="titles commits-title">
          <span className="title">Commits</span>
          <span className="subtitle">{scope === 'session' ? session.displayName : 'Everything in this project, newest first'}</span>
        </div>
        <div className="actions">
          <select className="branch-filter" title="Show only commits on this branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All branches</option>
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {current && <CopyHashButton hash={current.hash} label="Copy commit hash" />}
          <button title="Back to the session (Esc)" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <div className="commits-split">
        <nav className="commits-list">
          {error && <p className="muted pad">Cannot list commits: {error}</p>}
          {!error && commits === null && <p className="muted pad">Loading…</p>}
          {!error && commits?.length === 0 && (
            <p className="muted pad">
              {branch
                ? `No commits on ${branch}${scope === 'session' ? ' from this session' : ''}.`
                : scope === 'session'
                  ? 'This session has not made any commits yet. Commits are recorded when an agent commits from inside the session.'
                  : 'No commits found in this project.'}
            </p>
          )}
          {commits?.map((commit) => (
            <div
              key={commit.hash}
              className={`commit-row ${commit.hash === selected ? 'selected' : ''}`}
              onClick={() => setSelected(commit.hash)}
            >
              <span className="commit-row-title">{commit.title || '(no message)'}</span>
              <span className="commit-row-meta">
                {commit.branch && <span className="commit-branch-tag" title={`On ${commit.branch}`}>{commit.branch}</span>}
                {scope === 'all' && commit.agentTool && <ToolIcon tool={commit.agentTool} />}
                <span className="who">{scope === 'all' ? commit.sessionName ?? commit.author : commit.author}</span>
                <span className="when">{relativeTime(commit.authoredAt)}</span>
                <code>{commit.shortHash}</code>
              </span>
            </div>
          ))}
        </nav>
        <div className="commits-detail">
          {current && (
            <div className="commit-detail-head">
              <strong>{current.title}</strong>
              {current.message && <p className="muted small">{current.message}</p>}
              <div className="muted small">
                <code>{current.shortHash}</code> · {current.author} · {relativeTime(current.authoredAt)}
                {current.branch && <> · {current.branch}</>}
              </div>
            </div>
          )}
          <div className="diff-content">{current ? <DiffBody content={diff?.content ?? null} /> : <p className="muted">Select a commit to see its diff.</p>}</div>
        </div>
      </div>
    </div>
  )
}
