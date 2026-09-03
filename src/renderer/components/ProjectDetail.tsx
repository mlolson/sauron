import { useState } from 'react'
import type { Project, SelectionTarget, Session, ToolPaths } from '@shared/types'
import { StateDot } from './StateDot'
import { abbreviate } from './Sidebar'
import { relativeTime } from '../time'

interface Props {
  project: Project
  sessions: Session[]
  toolPaths: ToolPaths | null
  onSelect: (t: SelectionTarget) => void
}

export function ProjectDetail({ project, sessions, toolPaths, onSelect }: Props) {
  const [prompt, setPrompt] = useState('')
  const mine = sessions.filter((s) => s.projectId === project.id)
  const codexAvailable = Boolean(toolPaths?.codex)

  const launch = (tool: 'claude' | 'codex') => {
    void window.sauron.launchSession(project.id, tool, prompt.trim() || undefined)
    setPrompt('')
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

      <div className="launch-bar">
        <input
          type="text"
          placeholder="Optional initial prompt for the new session…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) launch('claude')
          }}
        />
        <button className="primary" onClick={() => launch('claude')}>
          New Claude
        </button>
        <button
          disabled={!codexAvailable}
          title={codexAvailable ? 'Start a Codex session in this project' : 'codex was not found on PATH'}
          onClick={() => launch('codex')}
        >
          New Codex
        </button>
      </div>

      <section className="card">
        <h2>Status</h2>
        <p className="muted">No summary yet. The master agent will write one in a later slice.</p>
      </section>

      <section className="card">
        <h2>Sessions</h2>
        {mine.length === 0 ? (
          <p className="muted">No sessions yet. Use New Claude or New Codex to start one.</p>
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
