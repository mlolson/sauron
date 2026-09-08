import { useEffect, useState } from 'react'
import { describeTrigger } from '@shared/jobs'
import { AgentsView } from './AgentsView'
import type { Preferences, Project, ToolPaths } from '@shared/types'

interface Props { preferences: Preferences; toolPaths: ToolPaths | null; projects: Project[]; schedulerLoaded: boolean | null; onClose: () => void }

function validateConfig(content: string): string | null {
  try {
    const value = JSON.parse(content) as { projects?: unknown; preferences?: { agents?: unknown } } | null
    if (!value || typeof value !== 'object') return 'Config must be a JSON object.'
    if (!Array.isArray(value.projects)) return 'Config must contain a projects array.'
    if (!value.preferences || typeof value.preferences !== 'object') return 'Config must contain a preferences object.'
    if (!Array.isArray(value.preferences.agents)) return 'preferences.agents must be an array.'
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
  const [managingAgents, setManagingAgents] = useState(false)

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
              <label className="pref-row check"><input type="checkbox" checked={preferences.supervisorEnabled} onChange={(e) => void window.sauron.setPreferences({ supervisorEnabled: e.target.checked })} /><span>Supervisor agent enabled (shown in the sidebar when on)</span></label>
              <label className="pref-row check"><input type="checkbox" disabled checked={!preferences.notificationsMuted} /><span>Show notifications when a session needs input or finishes</span></label>
              <label className="pref-row"><span>Supervisor agent</span><input readOnly value={preferences.supervisorAgentId} /></label>
              <label className="pref-row"><span>Supervisor arguments</span><input readOnly value={preferences.supervisorArgs.join(' ')} /></label>
              <label className="pref-row check"><input type="checkbox" disabled checked={preferences.masterAutoStart} /><span>Start the supervisor agent when Sauron launches</span></label>
            </section>
            <section><h3>Terminal</h3><label className="pref-row"><span>Font size</span><input type="number" readOnly value={preferences.terminalFontSize} /></label><label className="pref-row"><span>Scrollback lines</span><input type="number" readOnly value={preferences.terminalScrollback} /></label></section>
            <section>
              <h3>Background agents</h3>
              <label className="pref-row"><span>Defined agents</span><span><button onClick={() => setManagingAgents(true)}>Manage background agents…</button></span></label>
              <label className="pref-row"><span>Scheduler (launchd, every minute)</span><input readOnly value={schedulerLoaded === null ? 'not checked yet' : schedulerLoaded ? 'loaded — cron jobs run with the app closed' : 'not loaded; see the error banner'} /></label>
              {preferences.backgroundAgents.length === 0 ? (
                <p className="muted small">None defined. Create them from a project's Add background agent… button or context menu.</p>
              ) : preferences.backgroundAgents.map((t) => {
                const attachedTo = projects.filter((p) => p.backgroundJobs?.some((j) => j.template === t.id)).map((p) => p.name)
                return <label key={t.id} className="pref-row"><span>{t.name}</span><input readOnly value={`${t.agentId} · ${describeTrigger(t)}${t.autoMerge ? ' · auto-merge' : ''} · ${attachedTo.length ? `attached to ${attachedTo.join(', ')}` : 'not attached'}`} /></label>
              })}
            </section>
            <section><h3>Diagnostics</h3><button onClick={() => window.sauron.revealLogs()}>Reveal Logs</button></section>
          </>
        )}
      </div>
      {managingAgents && <AgentsView templates={preferences.backgroundAgents} agents={preferences.agents} projects={projects} onClose={() => setManagingAgents(false)} />}
    </div>
  )
}
