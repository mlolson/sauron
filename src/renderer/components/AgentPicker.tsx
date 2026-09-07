import { useState } from 'react'
import type { AgentDefinition, BackgroundAgentTemplate, Project } from '@shared/types'
import { describeTrigger, describeWorkspace } from '@shared/jobs'
import { JobDialog } from './JobDialog'
import { ToolIcon } from './ToolIcon'

/**
 * Attaches a background agent to a project from the list of those already defined. A new one
 * can be created from here; editing and deleting, which affect every project an agent is
 * attached to, live in Preferences. Attaching uses the agent's default trigger; the project
 * page is where a project overrides it.
 */
export function AgentPicker({ project, templates, agents, onClose }: {
  project: Project
  templates: BackgroundAgentTemplate[]
  agents: AgentDefinition[]
  onClose: () => void
}) {
  const [editing, setEditing] = useState<{ template: BackgroundAgentTemplate | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attached = new Set((project.backgroundJobs ?? []).map((j) => j.template))

  const attach = (template: BackgroundAgentTemplate) => {
    void window.sauron.saveProjectJobs(project.id, [...(project.backgroundJobs ?? []), { template: template.id, enabled: true }]).then(onClose, (e: Error) => setError(e.message))
  }
  const save = (template: BackgroundAgentTemplate) => {
    const next = templates.some((t) => t.id === template.id) ? templates.map((t) => (t.id === template.id ? template : t)) : [...templates, template]
    void window.sauron.saveBackgroundAgents(next).catch((e: Error) => setError(e.message))
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal job-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !editing && onClose()}>
        <header>
          <h2>Add background agent to {project.name}</h2>
        </header>
        {templates.length === 0 ? (
          <p className="muted">No background agents defined yet. Create one, and it can be attached to any project.</p>
        ) : (
          <ul className="job-list picker">
            {templates.map((template) => {
              const isAttached = attached.has(template.id)
              return (
                <li key={template.id}>
                  <span className="glyph"><ToolIcon tool={template.agentId} /></span>
                  <span className="name">
                    <span className="name-title">{template.name}</span>
                    <span className="muted small">{describeTrigger(template)} · {describeWorkspace(template.workspace ?? 'worktree')}{template.autoMerge ? ' · auto-merge' : ''} · {template.promptFile}</span>
                  </span>
                  <button className="primary" disabled={isAttached} title={isAttached ? 'Already attached to this project' : `Attach with its default trigger`} onClick={() => attach(template)}>
                    {isAttached ? 'Attached' : 'Attach'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {error && <p className="save-error">{error}</p>}
        <p className="muted small">Agents are edited and deleted in Preferences, since a change there reaches every project.</p>
        <div className="actions right">
          <button onClick={() => setEditing({ template: null })}>Create background agent…</button>
          <button onClick={onClose}>Close</button>
        </div>
        {editing && <JobDialog agents={agents} existing={editing.template} taken={templates.map((t) => t.id)} onSubmit={save} onClose={() => setEditing(null)} />}
      </div>
    </div>
  )
}
