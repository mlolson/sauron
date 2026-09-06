import type { BackgroundJob } from './types'

/** Pure trigger evaluation, shared by the hook path and tested without git or a database. */

/**
 * The least time between two commit-triggered runs of one job, whatever its cooldown. A burst
 * of commits — a rebase, a series of small fixes — must produce one run, and the first runner
 * takes a second or two to record itself, during which a second hook would otherwise see
 * nothing in progress.
 */
export const BURST_WINDOW_MS = 60_000

function spacingMs(cooldownMinutes: number): number {
  return Math.max(cooldownMinutes * 60_000, BURST_WINDOW_MS)
}

export interface TriggerState {
  /** Job ids with a run in progress. */
  running: Set<string>
  /** Last run start per job id, ISO. */
  lastRunAt: Map<string, string>
}

/**
 * Which commit-triggered jobs should start now. The caller has already established that the
 * commit was on the project's main checkout and was not made by a background run.
 */
export function dueCommitJobs(jobs: BackgroundJob[], state: TriggerState, now: Date): BackgroundJob[] {
  return jobs.filter((job) => {
    if (!job.enabled || job.trigger.kind !== 'commit') return false
    if (state.running.has(job.id)) return false
    const last = state.lastRunAt.get(job.id)
    if (!last) return true
    const elapsedMs = now.getTime() - new Date(last).getTime()
    return elapsedMs >= spacingMs(job.trigger.cooldownMinutes)
  })
}

/** The instant before which a job's last run must have started for it to be due again. */
export function cooldownCutoff(job: BackgroundJob & { trigger: { kind: 'commit' } }, now: Date): string {
  return new Date(now.getTime() - spacingMs(job.trigger.cooldownMinutes)).toISOString()
}
