import { useEffect, useState } from 'react'
import type { Preferences, ToolPaths } from '@shared/types'

interface Props {
  preferences: Preferences
  toolPaths: ToolPaths | null
  onClose: () => void
}

export function PreferencesView({ preferences, toolPaths, onClose }: Props) {
  const [draft, setDraft] = useState<Preferences>(preferences)
  useEffect(() => setDraft(preferences), [preferences])

  const save = (patch: Partial<Preferences>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    void window.sauron.setPreferences(patch)
  }
  const tool = (name: keyof Preferences['toolOverrides']) => (
    <label className="pref-row" key={name}>
      <span>
        <code>{name}</code>
        <span className="muted small"> resolved: {toolPaths?.[name] ?? 'not found'}</span>
      </span>
      <input
        type="text"
        placeholder="auto (from PATH)"
        value={draft.toolOverrides[name]}
        onChange={(e) => setDraft({ ...draft, toolOverrides: { ...draft.toolOverrides, [name]: e.target.value } })}
        onBlur={() => save({ toolOverrides: draft.toolOverrides })}
      />
    </label>
  )

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Preferences</h2>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </header>
        <section>
          <h3>Tools</h3>
          {(['claude', 'codex', 'tmux', 'git'] as const).map(tool)}
        </section>
        <section>
          <h3>Worktrees</h3>
          <label className="pref-row">
            <span>Base directory</span>
            <span className="inline">
              <input type="text" placeholder="~/Library/Application Support/Sauron/worktrees" value={draft.worktreeBase} onChange={(e) => setDraft({ ...draft, worktreeBase: e.target.value })} onBlur={() => save({ worktreeBase: draft.worktreeBase })} />
              <button
                onClick={() =>
                  void window.sauron.chooseDirectory('Choose the worktree base directory').then((dir) => {
                    if (dir) save({ worktreeBase: dir })
                  })
                }
              >
                Choose…
              </button>
            </span>
          </label>
        </section>
        <section>
          <h3>Notifications and supervisor agent</h3>
          <label className="pref-row check">
            <input type="checkbox" checked={!draft.notificationsMuted} onChange={(e) => save({ notificationsMuted: !e.target.checked })} />
            <span>Show notifications when a session needs input or finishes</span>
          </label>
          <label className="pref-row check">
            <input type="checkbox" checked={draft.masterAutoStart} onChange={(e) => save({ masterAutoStart: e.target.checked })} />
            <span>Start the supervisor agent when Sauron launches</span>
          </label>
          <label className="pref-row">
            <span>Hide external sessions idle longer than (hours)</span>
            <input type="number" min={1} value={draft.externalRecentHours} onChange={(e) => save({ externalRecentHours: Math.max(1, Number(e.target.value) || 24) })} />
          </label>
        </section>
        <section>
          <h3>Terminal</h3>
          <label className="pref-row">
            <span>Font size</span>
            <input type="number" min={9} max={24} value={draft.terminalFontSize} onChange={(e) => save({ terminalFontSize: Math.min(24, Math.max(9, Number(e.target.value) || 13)) })} />
          </label>
          <label className="pref-row">
            <span>Scrollback lines</span>
            <input type="number" min={1000} step={1000} value={draft.terminalScrollback} onChange={(e) => save({ terminalScrollback: Math.max(1000, Number(e.target.value) || 50000) })} />
          </label>
        </section>
        <section>
          <h3>Diagnostics</h3>
          <button onClick={() => window.sauron.revealLogs()}>Reveal Logs</button>
        </section>
      </div>
    </div>
  )
}
