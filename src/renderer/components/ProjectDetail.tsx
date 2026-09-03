import type { Project, SelectionTarget, Session } from '@shared/types'
import { StateDot } from './StateDot'
import { abbreviate } from './Sidebar'
import { relativeTime } from '../time'

interface Props {
  project: Project
  sessions: Session[]
  onSelect: (t: SelectionTarget) => void
}

export function ProjectDetail({ project, sessions, onSelect }: Props) {
  const mine = sessions.filter((s) => s.projectId === project.id)
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
        <div className="actions">
          <button className="primary" onClick={() => void window.sauron.launchClaude(project.id)}>
            New Claude
          </button>
        </div>
      </header>

      <section className="card">
        <h2>Status</h2>
        <p className="muted">No summary yet. The master agent will write one in a later slice.</p>
      </section>

      <section className="card">
        <h2>Sessions</h2>
        {mine.length === 0 ? (
          <p className="muted">No sessions yet. Use New Claude to start one.</p>
        ) : (
          <ul className="session-list">
            {mine.map((s) => (
              <li key={s.id} onClick={() => onSelect({ kind: 'session', id: s.id })}>
                <span className="glyph">{s.tool === 'claude' ? '✦' : '⌘'}</span>
                <span className="name">{s.displayName}</span>
                <StateDot state={s.state} />
                <span className="muted small">{relativeTime(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
