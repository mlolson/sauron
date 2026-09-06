import { useEffect, useRef, useState } from 'react'
import type { AgentDefinition, BackgroundJob, JobTrigger } from '@shared/types'
import { slugifyJobId } from '@shared/jobs'

/** Creates or edits one background job. The id is derived from the name on creation and fixed after. */
export function JobDialog({ agents, existing, taken, onSubmit, onClose }: {
  agents: AgentDefinition[]
  existing: BackgroundJob | null
  /** Ids already in use, so a new job cannot collide. */
  taken: string[]
  onSubmit: (job: BackgroundJob) => void
  onClose: () => void
}) {
  const runnable = agents.filter((a) => a.backgroundCommand?.length)
  const [name, setName] = useState(existing?.name ?? '')
  const [agentId, setAgentId] = useState(existing?.agentId ?? runnable[0]?.id ?? '')
  const [promptFile, setPromptFile] = useState(existing?.promptFile ?? '')
  const [kind, setKind] = useState<JobTrigger['kind']>(existing?.trigger.kind ?? 'manual')
  const [schedule, setSchedule] = useState(existing?.trigger.kind === 'cron' ? existing.trigger.schedule : '0 3 * * *')
  const [cooldown, setCooldown] = useState(existing?.trigger.kind === 'commit' ? existing.trigger.cooldownMinutes : 30)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [skipIfUnchanged, setSkipIfUnchanged] = useState(existing?.skipIfUnchanged ?? true)
  const [autoMerge, setAutoMerge] = useState(existing?.autoMerge ?? false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const id = existing?.id ?? slugifyJobId(name)
  const idTaken = !existing && taken.includes(id)
  const valid = name.trim() && agentId && promptFile.trim() && !idTaken && (kind !== 'cron' || schedule.trim())
  const submit = () => {
    if (!valid) return
    const trigger: JobTrigger = kind === 'cron' ? { kind, schedule: schedule.trim() } : kind === 'commit' ? { kind, cooldownMinutes: Math.max(0, cooldown) } : { kind }
    onSubmit({ id, name: name.trim(), enabled, agentId, promptFile: promptFile.trim(), trigger, skipIfUnchanged, autoMerge })
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal job-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>{existing ? 'Edit background agent' : 'Add background agent'}</h2>
        </header>
        <label className="pref-row"><span>Name</span><input ref={first} className="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Security review" /></label>
        <label className="pref-row"><span>Id</span><input className="text" value={id} readOnly title={existing ? 'Fixed once created; it names the run branches.' : 'Derived from the name'} /></label>
        {idTaken && <p className="save-error">A job with the id "{id}" already exists in this project.</p>}
        <label className="pref-row">
          <span>Agent</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {runnable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="pref-row"><span>Prompt file</span><input className="text" value={promptFile} onChange={(e) => setPromptFile(e.target.value)} placeholder="jobs/security-review.md" /></label>
        <p className="muted small">A Markdown file; relative paths resolve beside config.json. Supports {'{projectName}'}, {'{projectPath}'}, {'{branch}'}, {'{jobName}'}.</p>
        <label className="pref-row">
          <span>Trigger</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as JobTrigger['kind'])}>
            <option value="manual">Manual only</option>
            <option value="cron">On a schedule (cron)</option>
            <option value="commit">After commits</option>
          </select>
        </label>
        {kind === 'cron' && <label className="pref-row"><span>Schedule</span><input className="text" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 3 * * *" /></label>}
        {kind === 'commit' && <label className="pref-row"><span>Cooldown (minutes)</span><input className="text" type="number" min={0} value={cooldown} onChange={(e) => setCooldown(Number(e.target.value))} /></label>}
        {kind !== 'manual' && <p className="muted small">Scheduled and commit triggers arrive in a later phase; the job can be run now from the project page.</p>}
        <label className="pref-row check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Enabled</span></label>
        <label className="pref-row check"><input type="checkbox" checked={skipIfUnchanged} onChange={(e) => setSkipIfUnchanged(e.target.checked)} /><span>Skip when the project has no new commits since the last run</span></label>
        <label className="pref-row check"><input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} /><span>Merge automatically, without review</span></label>
        {autoMerge && (
          <p className="muted small">
            Only when the merge is clean and the main checkout has no uncommitted changes; otherwise the run waits in Review as usual. The
            agent ran unattended with permission prompts bypassed — enable this only for jobs whose output you would accept unread.
          </p>
        )}
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={submit}>{existing ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  )
}
