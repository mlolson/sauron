import type { BackgroundJob } from './types'
import { parseCron, previousFireTime } from './cron'
import { intervalMs } from './jobs'

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

/** How far back a scheduled minute may lie and still count. Missed ticks — the machine was
 * asleep — are caught up within this window, and a run is never started for a slot older. */
export const CRON_LOOKBACK_MINUTES = 24 * 60
/** A job that has never run is not started for a slot that passed before it was configured;
 * without a record of when that was, a short window stands in for it. */
export const CRON_FIRST_RUN_LOOKBACK_MINUTES = 60

/**
 * Cron jobs whose most recent scheduled minute has not yet had a run. Returns that minute
 * too: it is the claim's cutoff, so each scheduled slot starts at most one run.
 */
export function dueCronJobs(jobs: BackgroundJob[], state: TriggerState, now: Date): { job: BackgroundJob; scheduledAt: Date }[] {
  const due: { job: BackgroundJob; scheduledAt: Date }[] = []
  for (const job of jobs) {
    if (!job.enabled || job.trigger.kind !== 'cron' || state.running.has(job.id)) continue
    let spec
    try {
      spec = parseCron(job.trigger.schedule)
    } catch {
      continue // a bad expression never fires; the editor should have refused it
    }
    const last = state.lastRunAt.get(job.id)
    const scheduledAt = previousFireTime(spec, now, last ? CRON_LOOKBACK_MINUTES : CRON_FIRST_RUN_LOOKBACK_MINUTES)
    if (!scheduledAt) continue
    if (last && new Date(last).getTime() >= scheduledAt.getTime()) continue
    due.push({ job, scheduledAt })
  }
  return due
}

/**
 * Interval jobs whose spacing has elapsed since their last run began. A job that has never
 * run is due at once: "every day" starting now is what someone attaching it expects. The
 * instant returned is the claim's cutoff.
 */
export function dueIntervalJobs(jobs: BackgroundJob[], state: TriggerState, now: Date): { job: BackgroundJob; cutoff: Date }[] {
  const due: { job: BackgroundJob; cutoff: Date }[] = []
  for (const job of jobs) {
    if (!job.enabled || job.trigger.kind !== 'interval' || state.running.has(job.id)) continue
    const cutoff = new Date(now.getTime() - intervalMs(job.trigger))
    const last = state.lastRunAt.get(job.id)
    if (last && new Date(last).getTime() > cutoff.getTime()) continue
    due.push({ job, cutoff })
  }
  return due
}
