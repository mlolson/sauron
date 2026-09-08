import { useEffect, useState, type ReactNode } from 'react'
import type { RecentCommit, Session } from '@shared/types'
import { relativeTime } from '@shared/time'
import { CopyHashButton, CopyLabel, DiffBody } from './CommitUI'
import { ToolIcon } from './ToolIcon'

type Scope = 'session' | 'all'

/**
 * Commits for a session, list on the left and the selected commit's diff on the right.
 * Defaults to this session's own commits, which is the view only Sauron can offer: the
 * attribution store is what knows which agent made which commit.
 */
export function CommitsPane({ session, projectId, onClose, initialBranch, banner }: { session: Session; projectId: string; onClose: () => void; initialBranch?: string; banner?: ReactNode }) {
  const [scope, setScope] = useState<Scope>('session')
  // '' means every branch, which is what git log --all walks.
  const [branch, setBranch] = useState(initialBranch ?? '')
  const [branchDraft, setBranchDraft] = useState(initialBranch ?? '')
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

  /** Typing narrows the datalist; the list reloads only once the text names a real branch. */
  const applyBranch = (value: string) => {
    setBranchDraft(value)
    if (value === '' || branches.includes(value)) setBranch(value)
  }

  const current = commits?.find((c) => c.hash === selected)

  return (
    <div className="commits-pane">
      <header className="session-header">
        <div className="segmented">
          <button className={scope === 'session' ? 'active' : ''} onClick={() => setScope('session')}>
            This session
          </button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
            All sessions
          </button>
        </div>
        <div className="titles commits-title">
          <span className="title">Commits</span>
          <span className="subtitle">{scope === 'session' ? session.displayName : 'Every commit in this project, whoever made it'}</span>
        </div>
        <div className="actions">
          <span className="branch-filter-wrap">
            <input
              className="branch-filter"
              list="commit-branch-list"
              placeholder="All branches"
              title="Type to filter; pick a branch to show only its commits"
              value={branchDraft}
              onChange={(e) => applyBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                // Enter accepts the only branch the text could mean, so a filter can be set
                // without typing a long name in full.
                const matches = branches.filter((name) => name.toLowerCase().startsWith(branchDraft.toLowerCase()))
                if (matches.length === 1) applyBranch(matches[0]!)
              }}
            />
            <datalist id="commit-branch-list">
              {branches.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {branchDraft && (
              <button className="link branch-clear" title="Show every branch" onClick={() => applyBranch('')}>
                ×
              </button>
            )}
          </span>
          {current && <CopyHashButton hash={current.hash} label="Copy commit hash" />}
          <button title="Back to the session (Esc)" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      {banner}
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
                {current.branch && <> · <CopyLabel value={current.branch} /></>}
              </div>
            </div>
          )}
          <div className="diff-content">{current ? <DiffBody content={diff?.content ?? null} /> : <p className="muted">Select a commit to see its diff.</p>}</div>
        </div>
      </div>
    </div>
  )
}
