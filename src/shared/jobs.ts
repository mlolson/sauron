import type { BackgroundJob, JobRunStatus } from './types'

/** Pure helpers for background jobs, shared between the CLI runner and the app, and tested. */

/** `sauron/bg/<job>/<timestamp>`: sortable, unique per run, and recognisable as Sauron's. */
export function runBranchName(jobId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
  return `sauron/bg/${jobId}/${stamp}`
}

/** The job id from a run branch, or null for any other branch. */
export function jobIdOfBranch(branch: string): string | null {
  const m = /^sauron\/bg\/([^/]+)\//.exec(branch)
  return m?.[1] ?? null
}

/** Fills the prompt template. Unknown placeholders are left as written, so they are visible. */
export function expandJobPrompt(template: string, ctx: { projectName: string; projectPath: string; branch: string; jobName: string }): string {
  return template.replace(/\{(projectName|projectPath|branch|jobName)\}/g, (_m, key: keyof typeof ctx) => ctx[key])
}

/** What a finished run is, from how the agent exited and what it left on the branch. */
export function runOutcome(exitCode: number, commitCount: number): Exclude<JobRunStatus, 'running' | 'merged' | 'discarded'> {
  if (exitCode !== 0) return 'failed'
  return commitCount > 0 ? 'needs_review' : 'no_changes'
}

/**
 * The agent's final message, pulled from its output. Claude's JSON mode ends with a single
 * `result` record; anything else is summarised by its last non-empty lines.
 */
export function summarizeAgentOutput(output: string, maxChars = 2000): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  // Claude --output-format json prints one JSON document; stream-json prints one per line.
  for (const candidate of [trimmed, ...trimmed.split('\n').reverse()]) {
    if (!candidate.startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate) as { type?: unknown; result?: unknown }
      if (typeof parsed.result === 'string') return truncate(parsed.result.trim(), maxChars)
    } catch {
      // not JSON after all; fall through to plain-text handling
    }
  }
  const lines = trimmed.split('\n').filter((l) => l.trim())
  return truncate(lines.slice(-12).join('\n'), maxChars)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** A job id from a display name: lowercase, hyphenated, safe for branches and files. */
export function slugifyJobId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job'
}

export function describeTrigger(job: BackgroundJob): string {
  switch (job.trigger.kind) {
    case 'manual':
      return 'run manually'
    case 'cron':
      return `on schedule ${job.trigger.schedule}`
    case 'commit':
      return `after commits, at most every ${job.trigger.cooldownMinutes} min`
  }
}

/** Expands the agent-profile placeholders in an argument list. A known key with no value becomes empty; anything else is left as written. */
export function expandArgs(args: string[], values: Record<string, string | undefined>): string[] {
  return args.map((arg) => arg.replace(/\{(prompt|cwd|sessionId|sourceSessionId|sauronBin)\}/g, (_m, key: string) => values[key] ?? ''))
}
