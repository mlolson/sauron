import { useState } from 'react'
import type { SelectionTarget, Session, Snapshot } from '@shared/types'
import { isAlive } from '@shared/types'
import { SessionTerminal } from './SessionTerminal'
import { TranscriptView } from './TranscriptView'
import { StateDot } from './StateDot'

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
  const showTerminal = !external && alive && view === 'terminal'

  return (
    <div className="session-view">
      <header className="session-header">
        <div className="titles">
          <span className="title">{session.displayName}</span>
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
          <p>The tmux session is gone. Resume continues the same conversation in a new one.</p>
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
