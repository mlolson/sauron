import { useState } from 'react'
import type { AgentDefinition, BackgroundAgentTemplate, Project } from '@shared/types'
import { describeTrigger, describeWorkspace } from '@shared/jobs'
import { JobDialog } from './JobDialog'
import { ToolIcon } from './ToolIcon'

/**
 * The one place background agents are created, edited and deleted. They are shared across
 * projects, so a change here reaches every project the agent is attached to; project pages
 * only attach, detach and override the trigger.
 */
export function AgentsView({ templates, agents, projects, onClose }: {
  templates: BackgroundAgentTemplate[]
  agents: AgentDefinition[]
  projects: Project[]
  onClose: () => void
}) {
  const [editing, setEditing] = useState<{ template: BackgroundAgentTemplate | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const attachedTo = (id: string) => projects.filter((p) => p.backgroundJobs?.some((j) => j.template === id)).map((p) => p.name)
  const save = (template: BackgroundAgentTemplate) => {
    const next = templates.some((t) => t.id === template.id) ? templates.map((t) => (t.id === template.id ? template : t)) : [...templates, template]
    void window.sauron.saveBackgroundAgents(next).catch((e: Error) => setError(e.message))
  }
  const remove = (template: BackgroundAgentTemplate) => {
    const names = attachedTo(template.id)
    const where = names.length ? `\n\nIt is detached from ${names.join(', ')}.` : ''
    if (!confirm(`Delete the background agent "${template.name}"?${where} Past runs and their branches are kept.`)) return
    void window.sauron.saveBackgroundAgents(templates.filter((t) => t.id !== template.id)).catch((e: Error) => setError(e.message))
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal job-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !editing && onClose()}>
        <header>
          <h2>Background agents</h2>
          <div className="actions">
            <button className="primary" onClick={() => setEditing({ template: null })}>Create background agent…</button>
            <button className="link" onClick={onClose}>✕</button>
          </div>
        </header>
        <p className="muted small">Defined once and attached to projects from a project's page. Editing one here changes it everywhere it is attached.</p>
        {templates.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="job-list picker">
            {templates.map((template) => {
              const names = attachedTo(template.id)
              return (
                <li key={template.id}>
                  <span className="glyph"><ToolIcon tool={template.agentId} /></span>
                  <span className="name">
                    <span className="name-title">{template.name}</span>
                    <span className="muted small">{describeTrigger(template)} · {describeWorkspace(template.workspace ?? 'worktree')}{template.autoMerge ? ' · auto-merge' : ''} · {template.promptFile}</span>
                    <span className="muted small">{names.length ? `Attached to ${names.join(', ')}` : 'Not attached to any project'}</span>
                  </span>
                  <button onClick={() => setEditing({ template })}>Edit…</button>
                  <button className="destructive" onClick={() => remove(template)}>Delete</button>
                </li>
              )
            })}
          </ul>
        )}
        {error && <p className="save-error">{error}</p>}
        {editing && <JobDialog agents={agents} existing={editing.template} taken={templates.map((t) => t.id)} onSubmit={save} onClose={() => setEditing(null)} />}
      </div>
    </div>
  )
}
