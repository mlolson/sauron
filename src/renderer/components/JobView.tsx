import { useState } from 'react'
import type { BackgroundJob, JobRun, Project, SelectionTarget, Snapshot } from '@shared/types'
import { describeTrigger, describeWorkspace } from '@shared/jobs'
import { relativeTime } from '@shared/time'
import { CommitsPane } from './CommitsPane'
import { ToolIcon } from './ToolIcon'
import { TriggerDialog } from './TriggerDialog'
import { RunLogDialog, useRunLog } from './RunLogDialog'

/**
 * One background agent as attached to one project: what it is, when and where it runs, and
 * every run it has made here. Reached from the agent's row in the sidebar whether or not it
 * has ever run, so a freshly attached agent has somewhere to be looked at and started from.
 */
export function JobView({ project, job, snapshot, onSelect }: { project: Project; job: BackgroundJob; snapshot: Snapshot; onSelect: (t: SelectionTarget) => void }) {
  const [configuring, setConfiguring] = useState(false)
  const { logFor, showLog, closeLog } = useRunLog()
  const [reviewing, setReviewing] = useState<JobRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runs = (snapshot.runs[project.id] ?? []).filter((r) => r.jobId === job.id)
  const running = runs.find((r) => r.status === 'running')
  const template = snapshot.preferences.backgroundAgents.find((t) => t.id === job.id)
  const attached = project.backgroundJobs ?? []
  const act = (p: Promise<unknown>) => void p.catch((e: Error) => setError(e.message))

  const setEnabled = (enabled: boolean) => act(window.sauron.saveProjectJobs(project.id, attached.map((j) => (j.template === job.id ? { ...j, enabled } : j))))
  const detach = () => {
    if (confirm(`Detach "${job.name}" from ${project.name}?\n\nThe agent itself is kept, and so are past runs and their branches.`)) {
      act(window.sauron.saveProjectJobs(project.id, attached.filter((j) => j.template !== job.id)).then(() => onSelect({ kind: 'project', id: project.id })))
    }
  }
  const merge = (run: JobRun) => {
    if (confirm(`Merge "${job.name}" into the current branch?\n\n${run.commitCount} commit(s) from ${run.branch}. The worktree and branch are removed afterwards.`)) {
      setReviewing(null)
      act(window.sauron.mergeRun(run.id))
    }
  }
  const discard = (run: JobRun) => {
    if (confirm(`Discard this run of "${job.name}"?\n\nIts branch ${run.branch} and worktree are deleted.`)) {
      setReviewing(null)
      act(window.sauron.discardRun(run.id))
    }
  }
  const rerun = () => act(window.sauron.runJob(project.id, job.id))
  const awaiting = runs.filter((r) => r.status === 'needs_review').length

  return (
    <div className="page job-view">
      <header className="page-header">
        <div>
          <h1><ToolIcon tool={job.agentId} /> {job.name}</h1>
          <div className="path">
            <span className="muted">Background agent on </span>
            <button className="link" onClick={() => onSelect({ kind: 'project', id: project.id })}>{project.name}</button>
          </div>
        </div>
        <div className="actions">
          <button className="primary" disabled={!job.enabled || Boolean(running)} title={running ? 'A run is in progress' : job.enabled ? 'Start a run now' : 'Enable the agent first'} onClick={() => act(window.sauron.runJob(project.id, job.id))}>
            {running ? 'Running…' : 'Run now'}
          </button>
          <button onClick={() => setConfiguring(true)}>Configure…</button>
          <button onClick={() => setEnabled(!job.enabled)}>{job.enabled ? 'Disable' : 'Enable'}</button>
          <button className="destructive" onClick={detach}>Detach</button>
        </div>
      </header>
      {error && <p className="save-error">{error}</p>}

      <section className="card">
        <h2>Configuration</h2>
        <dl className="job-facts">
          <dt>Runs</dt><dd>{describeTrigger(job)}{job.customTrigger ? <span className="muted"> (set for this project)</span> : <span className="muted"> (the agent's default)</span>}</dd>
          <dt>Where</dt><dd>{describeWorkspace(job.workspace)}{job.workspace === 'main' ? <span className="muted"> · no review step</span> : job.autoMerge ? <span className="muted"> · merged automatically when clean</span> : <span className="muted"> · output waits in Review</span>}</dd>
          <dt>Agent profile</dt><dd>{snapshot.preferences.agents.find((a) => a.id === job.agentId)?.name ?? job.agentId}</dd>
          <dt>Prompt file</dt><dd><code>{job.promptFile}</code></dd>
          <dt>Skip if unchanged</dt><dd>{job.skipIfUnchanged ? 'yes, when the project has no new commits since the last run' : 'no'}</dd>
          <dt>State</dt><dd>{job.enabled ? 'enabled' : 'disabled for this project'}{template?.builtIn ? <span className="muted"> · built into Sauron</span> : null}</dd>
        </dl>
        <p className="muted small">The prompt, agent profile and defaults are edited in Preferences › Manage background agents. Configure… sets this project's own trigger and workspace.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Runs</h2>
          <span className="muted small">
            {runs.length === 0 ? 'Has not run on this project yet' : `${runs.length} on this project, newest first`}
            {awaiting > 0 && ` · ${awaiting} waiting for review`}
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="muted">Nothing yet. {job.enabled ? `It will run ${describeTrigger(job)}, or click Run now.` : 'Enable it to let its trigger start runs, or click Run now after enabling.'}</p>
        ) : (
          <ul className="run-list">
            {runs.map((run) => {
              const session = snapshot.sessions.find((s) => s.id === run.sessionId)
              return (
                <li key={run.id}>
                  <div className="run-head">
                    <span className={`run-status ${run.status}`}>{run.status.replace('_', ' ')}</span>
                    <span className="muted small">
                      {run.status === 'running' ? `started ${relativeTime(run.startedAt)}` : `finished ${relativeTime(run.finishedAt ?? run.startedAt)}`}
                      {' · '}{run.trigger === 'manual' ? 'started by hand' : `${run.trigger} trigger`}
                      {run.branch && <> · <code>{run.branch}</code></>}
                      {run.workspace === 'worktree' && run.status !== 'running' && ` · ${run.commitCount} commit${run.commitCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {run.summary && <p className="run-summary">{run.summary}</p>}
                  <div className="commit-actions">
                    {session && <button onClick={() => onSelect({ kind: 'session', id: session.id })}>{run.status === 'running' ? 'Watch' : 'Session'}</button>}
                    <button onClick={() => void showLog(run)}>Log</button>
                    {run.status !== 'running' && <button disabled={Boolean(running) || !job.enabled} title={running ? 'A run is in progress' : 'Start a new run'} onClick={rerun}>Re-run</button>}
                    {run.status === 'needs_review' && (
                      <>
                        <button className="primary" disabled={!session} title={session ? 'Read the commits and their diffs' : 'The run session is gone'} onClick={() => setReviewing(run)}>Review commits</button>
                        <button onClick={() => merge(run)}>Merge</button>
                        <button onClick={() => act(window.sauron.openRun(run.id))}>Open in session</button>
                        <button className="destructive" onClick={() => discard(run)}>Discard</button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {configuring && (
        <TriggerDialog
          project={project}
          job={job}
          defaultTrigger={template?.trigger ?? { kind: 'manual' }}
          defaultWorkspace={template?.workspace ?? 'worktree'}
          onClose={() => setConfiguring(false)}
        />
      )}
      {reviewing && (() => {
        const session = snapshot.sessions.find((s) => s.id === reviewing.sessionId)
        if (!session) return null
        return (
          <div className="review-pane">
            <CommitsPane
              session={session}
              projectId={project.id}
              initialBranch={reviewing.branch ?? undefined}
              onClose={() => setReviewing(null)}
              banner={
                <div className="review-banner">
                  <div>
                    <strong>{job.name}</strong>
                    <span className="muted small"> · {reviewing.commitCount} commit{reviewing.commitCount === 1 ? '' : 's'} on <code>{reviewing.branch}</code></span>
                    {reviewing.summary && <p className="run-summary">{reviewing.summary}</p>}
                  </div>
                  <div className="commit-actions">
                    <button className="primary" onClick={() => merge(reviewing)}>Merge</button>
                    <button onClick={() => act(window.sauron.openRun(reviewing.id))}>Open in session</button>
                    <button className="destructive" onClick={() => discard(reviewing)}>Discard</button>
                  </div>
                </div>
              }
            />
          </div>
        )
      })()}
      {logFor && (
        <RunLogDialog name={job.name} text={logFor.text} onClose={closeLog} />
      )}
    </div>
  )
}
