import { useEffect, useRef, useState } from 'react'
import type { SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { SessionTerminal } from './SessionTerminal'
import { TranscriptView } from './TranscriptView'
import { StateDot } from './StateDot'
import { ToolIcon } from './ToolIcon'

interface Props {
  session: Session
  snapshot: Snapshot
  onSelect: (t: SelectionTarget) => void
}

export function SessionView({ session, snapshot, onSelect }: Props) {
  const project = session.projectId ? snapshot.projects.find((p) => p.id === session.projectId) : undefined
  const siblings = snapshot.sessions.filter((s) => s.projectId === session.projectId && s.kind === 'managed' && (isAlive(s) || s.id === session.id))
  const alive = isAlive(session)
  const external = session.kind === 'external'
  const [view, setView] = useState<'terminal' | 'transcript'>(external ? 'transcript' : 'terminal')
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
            {project?.name ?? 'Unassigned'}
            {external && ' · external'}
          </span>
        </div>
        {!external && (
          <div className="tabs">
            {siblings.map((s) => (
              <button key={s.id} className={`tab ${s.id === session.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'session', id: s.id })}>
                <StateDot state={s.state} />
                <ToolIcon tool={s.tool} />
                {s.displayName}
              </button>
            ))}
          </div>
        )}
        {external && <div className="tabs" />}
        <div className="actions">
          {!external && alive && session.transcriptPath && (
            <div className="segmented">
              <button className={view === 'terminal' ? 'active' : ''} onClick={() => setView('terminal')}>
                Terminal
              </button>
              <button className={view === 'transcript' ? 'active' : ''} onClick={() => setView('transcript')}>
                Transcript
              </button>
            </div>
          )}
          {!external && alive && session.tmuxName && (
            <button title={`Copy: tmux attach -t ${session.tmuxName}`} onClick={() => window.sauron.copyToClipboard(`tmux attach -t ${session.tmuxName}`)}>
              Copy attach
            </button>
          )}
          {!external && alive && (
            <button title="Close this terminal; the session keeps running in tmux" onClick={() => void window.sauron.detachSession(session.id)}>
              Detach
            </button>
          )}
          {!external && alive && (
            <button className="destructive" title="Interrupt the agent and end the tmux session" onClick={() => void window.sauron.stopSession(session.id)}>
              Stop
            </button>
          )}
        </div>
      </header>
      {showTerminal ? (
        <SessionTerminal sessionId={session.id} fontSize={snapshot.preferences.terminalFontSize} scrollback={snapshot.preferences.terminalScrollback} />
      ) : external || (alive && view === 'transcript') ? (
        <TranscriptView sessionId={session.id} readOnly={external} />
      ) : (
        <div className="placeholder">
          <div className="big">■</div>
          <h2>Session Stopped</h2>
          <p>{session.cliSessionId ? 'The tmux session is gone. Resume starts a new terminal and continues the same agent conversation.' : 'The tmux session is gone. Restart opens a new terminal in the same directory.'}</p>
          <div className="actions">
            <button className="primary" onClick={() => void window.sauron.resumeSession(session.id)}>
              {session.cliSessionId ? 'Resume' : 'Restart terminal'}
            </button>
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
