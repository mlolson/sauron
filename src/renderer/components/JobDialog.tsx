import { useEffect, useRef, useState } from 'react'
import type { AgentDefinition, BackgroundAgentTemplate, JobTrigger, JobWorkspace } from '@shared/types'
import { WorkspaceSelect } from './WorkspaceSelect'
import { slugifyJobId } from '@shared/jobs'
import { TriggerEditor } from './TriggerEditor'

/**
 * Creates or edits one background agent. Agents are defined once and attached to projects;
 * the trigger set here is the default a project gets when it attaches the agent.
 */
export function JobDialog({ agents, existing, taken, onSubmit, onClose }: {
  agents: AgentDefinition[]
  existing: BackgroundAgentTemplate | null
  /** Ids already in use, so a new agent cannot collide. */
  taken: string[]
  onSubmit: (template: BackgroundAgentTemplate) => void
  onClose: () => void
}) {
  const runnable = agents.filter((a) => a.backgroundCommand?.length)
  const [name, setName] = useState(existing?.name ?? '')
  const [agentId, setAgentId] = useState(existing?.agentId ?? runnable[0]?.id ?? '')
  const [promptFile, setPromptFile] = useState(existing?.promptFile ?? '')
  const [trigger, setTrigger] = useState<JobTrigger>(existing?.trigger ?? { kind: 'manual' })
  const [workspace, setWorkspace] = useState<JobWorkspace>(existing?.workspace ?? 'worktree')
  const [skipIfUnchanged, setSkipIfUnchanged] = useState(existing?.skipIfUnchanged ?? true)
  const [autoMerge, setAutoMerge] = useState(existing?.autoMerge ?? false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const id = existing?.id ?? slugifyJobId(name)
  const idTaken = !existing && taken.includes(id)
  const valid = name.trim() && agentId && promptFile.trim() && !idTaken && (trigger.kind !== 'cron' || trigger.schedule) && (trigger.kind !== 'interval' || trigger.every >= 1)
  const submit = () => {
    if (!valid) return
    onSubmit({ id, name: name.trim(), agentId, promptFile: promptFile.trim(), trigger, workspace, skipIfUnchanged, autoMerge })
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal job-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>{existing ? 'Edit background agent' : 'Create background agent'}</h2>
        </header>
        <label className="pref-row"><span>Name</span><input ref={first} className="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Security review" /></label>
        <label className="pref-row"><span>Id</span><input className="text" value={id} readOnly title={existing ? 'Fixed once created; it names the run branches.' : 'Derived from the name'} /></label>
        {idTaken && <p className="save-error">A background agent with the id "{id}" already exists.</p>}
        <label className="pref-row">
          <span>Agent profile</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {runnable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="pref-row"><span>Prompt file</span><input className="text" value={promptFile} onChange={(e) => setPromptFile(e.target.value)} placeholder="jobs/security-review.md" /></label>
        <p className="muted small">A Markdown file; relative paths resolve beside config.json. Supports {'{projectName}'}, {'{projectPath}'}, {'{branch}'}, {'{jobName}'}.</p>
        <h3>Defaults</h3>
        <p className="muted small">What a project gets when it attaches this agent. Each project can override both.</p>
        <TriggerEditor value={trigger} onChange={setTrigger} />
        <WorkspaceSelect value={workspace} onChange={(w) => setWorkspace(w ?? 'worktree')} />
        <h3>Options</h3>
        <label className="pref-row check"><input type="checkbox" checked={skipIfUnchanged} onChange={(e) => setSkipIfUnchanged(e.target.checked)} /><span>Skip when the project has no new commits since the last run</span></label>
        {workspace === 'worktree' && <label className="pref-row check"><input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} /><span>Merge automatically, without review</span></label>}
        {workspace === 'worktree' && autoMerge && (
          <p className="muted small">
            Only when the merge is clean and the main checkout has no uncommitted changes; otherwise the run waits in Review as usual. The
            agent runs unattended with permission prompts bypassed — enable this only for agents whose output you would accept unread.
          </p>
        )}
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={submit}>{existing ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}
