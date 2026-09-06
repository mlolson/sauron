import { useState } from 'react'
import type { BackgroundJob, JobTrigger, Project } from '@shared/types'
import { describeTrigger } from '@shared/jobs'
import { TriggerEditor } from './TriggerEditor'

/** Sets when an attached background agent runs for this project, or hands it back to the agent's default. */
export function TriggerDialog({ project, job, defaultTrigger, onClose }: {
  project: Project
  job: BackgroundJob
  /** The agent's own trigger, used when the project has no override. */
  defaultTrigger: JobTrigger
  onClose: () => void
}) {
  const [custom, setCustom] = useState(job.customTrigger)
  const [trigger, setTrigger] = useState<JobTrigger>(job.trigger)
  const [error, setError] = useState<string | null>(null)
  const valid = !custom || ((trigger.kind !== 'cron' || trigger.schedule) && (trigger.kind !== 'interval' || trigger.every >= 1))

  const submit = () => {
    const next = (project.backgroundJobs ?? []).map((j) => (j.template === job.id ? { ...j, trigger: custom ? trigger : undefined } : j))
    void window.sauron.saveProjectJobs(project.id, next).then(onClose, (e: Error) => setError(e.message))
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal job-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header><h2>{job.name} · trigger for {project.name}</h2></header>
        <label className="pref-row check"><input type="checkbox" checked={!custom} onChange={(e) => setCustom(!e.target.checked)} /><span>Use the agent's default: {describeTrigger({ trigger: defaultTrigger })}</span></label>
        <fieldset className="trigger-fields" disabled={!custom}>
          {/* Keyed so the editor's drafts reset when it switches between the default and the override. */}
          <TriggerEditor key={custom ? 'custom' : 'default'} value={custom ? trigger : defaultTrigger} onChange={setTrigger} />
        </fieldset>
        {error && <p className="save-error">{error}</p>}
        <div className="actions right">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  )
}
