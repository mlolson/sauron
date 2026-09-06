import { useEffect, useState } from 'react'
import type { Preferences, Project, ToolPaths } from '@shared/types'

interface Props { preferences: Preferences; toolPaths: ToolPaths | null; projects: Project[]; schedulerLoaded: boolean | null; onClose: () => void }

function validateConfig(content: string): string | null {
  try {
    const value = JSON.parse(content) as { projects?: unknown; preferences?: { agents?: unknown; supervisorProjectSummaryAfterCommit?: unknown; supervisorProjectSummaryAfterCommitCooldownMinutes?: unknown; supervisorProjectSummaryPromptFile?: unknown } } | null
    if (!value || typeof value !== 'object') return 'Config must be a JSON object.'
    if (!Array.isArray(value.projects)) return 'Config must contain a projects array.'
    if (!value.preferences || typeof value.preferences !== 'object') return 'Config must contain a preferences object.'
    if (!Array.isArray(value.preferences.agents)) return 'preferences.agents must be an array.'
    if (typeof value.preferences.supervisorProjectSummaryAfterCommit !== 'boolean') return 'supervisorProjectSummaryAfterCommit must be a boolean.'
    if (typeof value.preferences.supervisorProjectSummaryAfterCommitCooldownMinutes !== 'number') return 'supervisorProjectSummaryAfterCommitCooldownMinutes must be a number.'
    if (typeof value.preferences.supervisorProjectSummaryPromptFile !== 'string' || !value.preferences.supervisorProjectSummaryPromptFile.trim()) return 'supervisorProjectSummaryPromptFile must be a non-empty string.'
    for (const item of value.preferences.agents) {
      const agent = item as { id?: unknown; name?: unknown; command?: unknown; args?: unknown; forkCommand?: unknown } | null
      if (!agent || typeof agent.id !== 'string' || !agent.id || typeof agent.name !== 'string' || typeof agent.command !== 'string' || !Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === 'string')) {
        return 'Every agent needs string id, name, command, and a string args array.'
      }
      if (agent.forkCommand !== undefined && (!Array.isArray(agent.forkCommand) || !agent.forkCommand.every((arg) => typeof arg === 'string'))) return 'Agent forkCommand must be a string array when present.'
    }
    return null
  } catch (error) {
    return (error as Error).message
  }
}

export function PreferencesView({ preferences, toolPaths, projects, schedulerLoaded, onClose }: Props) {
  const [editor, setEditor] = useState<{ path: string; content: string; original: string } | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!editor) return
    setJsonError(validateConfig(editor.content))
  }, [editor?.content])

  const loadEditor = async () => {
    const config = await window.sauron.getConfigFile()
    setEditor({ ...config, original: config.content })
    setSaved(false)
  }
  const copyPath = async () => {
    const config = editor ?? await window.sauron.getConfigFile()
    window.sauron.copyToClipboard(config.path)
  }
  const saveEditor = async () => {
    if (!editor || jsonError) return
    const parsed = JSON.parse(editor.content) as { preferences?: Partial<Preferences> }
    const nextSupervisor = parsed.preferences?.supervisorAgentId ?? preferences.supervisorAgentId
    const nextArgs = parsed.preferences?.supervisorArgs ?? preferences.supervisorArgs
    const supervisorChanged = nextSupervisor !== preferences.supervisorAgentId || JSON.stringify(nextArgs) !== JSON.stringify(preferences.supervisorArgs)
    if (supervisorChanged && !confirm('Changing the supervisor configuration will restart the supervisor agent. Continue?')) return
    await window.sauron.saveConfigFile(editor.content)
    if (supervisorChanged) await window.sauron.restartMaster()
    const config = await window.sauron.getConfigFile()
    setEditor({ ...config, original: config.content })
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }
  const closeEditor = () => {
    if (editor?.content !== editor?.original && !confirm('Discard unsaved config changes?')) return
    setEditor(null)
  }
  const closePreferences = () => {
    if (editor?.content !== editor?.original && !confirm('Discard unsaved config changes?')) return
    onClose()
  }
  const tool = (name: 'tmux' | 'git') => (
    <label className="pref-row" key={name}>
      <span><code>{name}</code><span className="muted small"> resolved: {toolPaths?.[name] ?? 'not found'}</span></span>
      <input type="text" readOnly value={preferences.toolOverrides[name]} placeholder="auto (from PATH)" />
    </label>
  )

  return (
    <div className="modal-backdrop" onMouseDown={closePreferences}>
      <div className="modal preferences-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Preferences</h2>
          <div className="actions preferences-actions">
            <button className="primary edit-config-button" onClick={() => void loadEditor()}>Edit config</button>
            <button onClick={() => void copyPath()}>Copy config filepath</button>
            <button className="link" onClick={closePreferences}>✕</button>
          </div>
        </header>
        {editor ? (
          <section className="config-editor">
            <div className="inline config-editor-header">
              <code>{editor.path}</code>
            </div>
            <textarea value={editor.content} onChange={(e) => { setSaved(false); setEditor({ ...editor, content: e.target.value }) }} spellCheck={false} />
            {jsonError && <div className="config-error">Invalid JSON: {jsonError}</div>}
            <div className="actions config-editor-actions">
              {saved && <span className="config-saved" role="status">Settings saved</span>}
              <button className="primary" disabled={Boolean(jsonError)} onClick={() => void saveEditor()}>Save</button>
              <button onClick={closeEditor}>Close</button>
            </div>
          </section>
        ) : (
          <>
            <section><h3>Tools</h3>{(['tmux', 'git'] as const).map(tool)}</section>
            <section><h3>Agent profiles</h3>{preferences.agents.map((agent) => (
              <div className="pref-agent" key={agent.id}>
                <label className="pref-row"><span>Name</span><input readOnly value={agent.name} /></label>
                <label className="pref-row"><span>ID</span><input readOnly value={agent.id} /></label>
                <label className="pref-row"><span>Executable</span><input readOnly value={agent.command} /></label>
                <label className="pref-row"><span>Arguments</span><input readOnly value={agent.args.join(' ')} /></label>
                <label className="pref-row"><span>Fork command</span><input readOnly value={agent.forkCommand?.join(' ') ?? 'Not configured'} /></label>
                <span className="muted small">resolved: {toolPaths?.agents[agent.id] ?? 'not found'}</span>
              </div>
            ))}</section>
            <section><h3>Worktrees</h3><label className="pref-row"><span>Base directory</span><input readOnly value={preferences.worktreeBase} placeholder="default under Application Support" /></label></section>
            <section>
              <h3>Notifications and supervisor agent</h3>
              <label className="pref-row check"><input type="checkbox" disabled checked={preferences.supervisorEnabled} /><span>Supervisor agent enabled</span></label>
              <label className="pref-row check"><input type="checkbox" disabled checked={!preferences.notificationsMuted} /><span>Show notifications when a session needs input or finishes</span></label>
              <label className="pref-row"><span>Supervisor agent</span><input readOnly value={preferences.supervisorAgentId} /></label>
              <label className="pref-row"><span>Supervisor arguments</span><input readOnly value={preferences.supervisorArgs.join(' ')} /></label>
              <label className="pref-row check"><input type="checkbox" disabled checked={preferences.supervisorProjectSummaryAfterCommit} /><span>Generate a project summary after commits</span></label>
              <label className="pref-row"><span>Post-commit summary cooldown (minutes)</span><input type="number" readOnly value={preferences.supervisorProjectSummaryAfterCommitCooldownMinutes} /></label>
              <label className="pref-row"><span>Project summary prompt file</span><input readOnly value={preferences.supervisorProjectSummaryPromptFile} /></label>
              <label className="pref-row check"><input type="checkbox" disabled checked={preferences.masterAutoStart} /><span>Start the supervisor agent when Sauron launches</span></label>
            </section>
            <section><h3>Terminal</h3><label className="pref-row"><span>Font size</span><input type="number" readOnly value={preferences.terminalFontSize} /></label><label className="pref-row"><span>Scrollback lines</span><input type="number" readOnly value={preferences.terminalScrollback} /></label></section>
            <section>
              <h3>Background agents</h3>
              <label className="pref-row"><span>Scheduler (launchd, every minute)</span><input readOnly value={schedulerLoaded === null ? 'not checked yet' : schedulerLoaded ? 'loaded — cron jobs run with the app closed' : 'not loaded; see the error banner'} /></label>
              {projects.every((p) => !(p.backgroundJobs?.length)) ? (
                <p className="muted small">None configured. Add them from a project's page or context menu.</p>
              ) : projects.filter((p) => p.backgroundJobs?.length).map((p) => (
                <div key={p.id} className="pref-group">
                  <h4>{p.name}</h4>
                  {p.backgroundJobs!.map((j) => (
                    <label key={j.id} className="pref-row"><span>{j.name}{j.enabled ? '' : ' (disabled)'}</span><input readOnly value={`${j.agentId} · ${j.trigger.kind === 'cron' ? j.trigger.schedule : j.trigger.kind === 'commit' ? `after commits, ${j.trigger.cooldownMinutes} min cooldown` : 'manual'} · ${j.promptFile}`} /></label>
                  ))}
                </div>
              ))}
            </section>
            <section><h3>Diagnostics</h3><button onClick={() => window.sauron.revealLogs()}>Reveal Logs</button></section>
          </>
        )}
      </div>
    </div>
  )
}
