import { useEffect, useRef, useState } from 'react'
import type { SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { SessionTerminal } from './SessionTerminal'
import { TranscriptView } from './TranscriptView'
import { CommitsPane } from './CommitsPane'
import { ToolIcon } from './ToolIcon'
import { importExternalSession } from './Sidebar'

interface Props {
  session: Session
  snapshot: Snapshot
  onSelect: (t: SelectionTarget) => void
}

export function SessionView({ session, snapshot, onSelect }: Props) {
  const project = session.projectId ? snapshot.projects.find((p) => p.id === session.projectId) : undefined
  // Where this session actually runs, and the checkout that directory belongs to.
  const cwd = session.worktreePath ?? session.workingDir
  const worktree = session.projectId ? snapshot.worktrees[session.projectId]?.find((w) => w.path === cwd) : undefined
  const branch = worktree?.branch ?? null
  const worktreeLabel = worktree?.isMain ? 'main checkout' : cwd.split('/').pop() ?? cwd
  const alive = isAlive(session)
  const external = session.kind === 'external'
  const forkable = Boolean(snapshot.preferences.agents.find((agent) => agent.id === session.tool)?.forkCommand?.length && session.cliSessionId)
  const [view, setView] = useState<'terminal' | 'transcript'>(external ? 'transcript' : 'terminal')
  const [showCommits, setShowCommits] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.displayName)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) {
      titleInput.current?.focus()
      titleInput.current?.select()
    }
  }, [editing])
  const commitTitle = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== session.displayName) void window.sauron.renameSession(session.id, draft.trim())
  }
  const showTerminal = !external && alive && view === 'terminal'

  return (
    <div className="session-view">
      <header className="session-header">
        <ToolIcon tool={session.tool} className="large" />
        <div className="titles">
          {editing ? (
            <input
              ref={titleInput}
              className="title-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
          ) : (
            <span
              className={`title ${external ? '' : 'editable'}`}
              title={external ? undefined : 'Click to rename'}
              onClick={() => {
                if (external) return
                setDraft(session.displayName)
                setEditing(true)
              }}
            >
              {session.displayName}
            </span>
          )}
          <span className="subtitle">
            {project ? (
              <button className="link" onClick={() => onSelect({ kind: 'project', id: project.id })}>
                {project.name}
              </button>
            ) : (
              'Unassigned'
            )}
            {external && ' · external'}
          </span>
        </div>
        <div className="session-meta">
          <span className="chip" title={branch ? `Branch ${branch}` : 'This checkout is not on a branch'}>
            <span className="k">branch</span>
            <span className="v">{branch ?? 'detached'}</span>
          </span>
          <span className="chip" title={cwd}>
            <span className="k">worktree</span>
            <span className="v">{worktreeLabel}</span>
          </span>
        </div>
        <div className="actions">
          {session.projectId && (
            <button title="Commits made by this session, and the rest of the project's history" onClick={() => setShowCommits(true)}>
              Commits
            </button>
          )}
          {!external && alive && session.tmuxName && (
            <button title={`Copy: tmux attach -t ${session.tmuxName}`} onClick={() => window.sauron.copyToClipboard(`tmux attach -t ${session.tmuxName}`)}>
              Copy tmux attach cmd
            </button>
          )}
          {!external && alive && (
            <button
              className="destructive"
              title={session.tool === 'shell' ? 'Kill this terminal. Plain terminals cannot be resumed.' : 'Kill this terminal. The agent conversation stays resumable.'}
              onClick={() => {
                const keeps = session.tool !== 'shell' && session.cliSessionId
                if (keeps || confirm(`Close ${session.displayName}?\n\nThis kills the terminal. Plain terminals cannot be resumed.`)) void window.sauron.closeSession(session.id)
              }}
            >
              Close
            </button>
          )}
          {external && forkable && (
            <button title="Bring this session under Sauron: a managed session continues a copy of the conversation. The original keeps running in your terminal." onClick={() => void importExternalSession(session)}>
              Import
            </button>
          )}
          {external && (
            <button title="Remove this session from Sauron. It keeps running in your terminal." onClick={() => void window.sauron.hideSession(session.id)}>
              Hide
            </button>
          )}
        </div>
      </header>
      {showCommits && session.projectId && (
        <CommitsPane session={session} projectId={session.projectId} onClose={() => setShowCommits(false)} />
      )}
      {showTerminal ? (
        <SessionTerminal sessionId={session.id} fontSize={snapshot.preferences.terminalFontSize} scrollback={snapshot.preferences.terminalScrollback} />
      ) : external || (alive && view === 'transcript') ? (
        <TranscriptView sessionId={session.id} readOnly={external} />
      ) : (
        <div className="placeholder">
          <div className="big">■</div>
          <h2>Session Closed</h2>
          <p>{session.cliSessionId ? 'Resume starts a new terminal and continues this agent conversation.' : 'This terminal is gone.'}</p>
          <div className="actions">
            {session.cliSessionId && (
              <button className="primary" onClick={() => void window.sauron.resumeSession(session.id)}>
                Resume
              </button>
            )}
            <button onClick={() => void window.sauron.forgetSession(session.id)}>Forget</button>
            {session.transcriptPath && <button onClick={() => setView('transcript')}>View transcript</button>}
          </div>
          {view === 'transcript' && session.transcriptPath && (
            <div className="stopped-transcript">
              <TranscriptView sessionId={session.id} readOnly />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
