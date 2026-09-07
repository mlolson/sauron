import type { BackgroundAgentTemplate, BackgroundJob, JobRunStatus, JobTrigger, JobWorkspace, Project } from './types'

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
export function expandJobPrompt(template: string, ctx: { projectName: string; projectPath: string; branch: string; jobName: string; projectId?: string; previousSummaryUpdatedAt?: string }): string {
  return template.replace(/\{(projectName|projectPath|branch|jobName|projectId|previousSummaryUpdatedAt)\}/g, (m, key: keyof typeof ctx) => ctx[key] ?? m)
}

export const PROJECT_SUMMARIZER_ID = 'project-summarizer'

/** The built-in summarizer as it ships. Runs in the main checkout so it can write the project's own status file. */
export function projectSummarizerTemplate(): BackgroundAgentTemplate {
  return {
    id: PROJECT_SUMMARIZER_ID,
    name: 'Project summarizer',
    agentId: 'claude',
    promptFile: 'jobs/project-summarizer.md',
    workspace: 'main',
    trigger: { kind: 'commit', cooldownMinutes: 5 },
    skipIfUnchanged: true,
    builtIn: true,
  }
}

/** Adds any built-in template that is missing, keeping a user's edits to one that exists. */
export function ensureBuiltInTemplates(templates: BackgroundAgentTemplate[]): { templates: BackgroundAgentTemplate[]; added: number } {
  const builtIns = [projectSummarizerTemplate()]
  const missing = builtIns.filter((b) => !templates.some((t) => t.id === b.id))
  return { templates: missing.length ? [...missing, ...templates] : templates, added: missing.length }
}

/** Attaches a template to every project that lacks it. Returns how many were attached. Projects are changed in place. */
export function attachToAllProjects(projects: Pick<Project, 'backgroundJobs'>[], templateId: string): number {
  let attached = 0
  for (const project of projects) {
    if (project.backgroundJobs?.some((j) => j.template === templateId)) continue
    project.backgroundJobs = [...(project.backgroundJobs ?? []), { template: templateId, enabled: true }]
    attached++
  }
  return attached
}

/** What a finished run is, from how the agent exited and what it left on the branch. */
export function runOutcome(exitCode: number, commitCount: number, workspace: JobWorkspace = 'worktree'): Exclude<JobRunStatus, 'running' | 'merged' | 'discarded'> {
  if (exitCode !== 0) return 'failed'
  // A main-checkout run has no branch to review: whatever it did is already in place.
  if (workspace === 'main') return 'done'
  return commitCount > 0 ? 'needs_review' : 'no_changes'
}

export function describeWorkspace(workspace: JobWorkspace): string {
  return workspace === 'main' ? 'in the main checkout' : 'in a fresh worktree'
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

export function describeTrigger(job: { trigger: JobTrigger }): string {
  const t = job.trigger
  switch (t.kind) {
    case 'manual':
      return 'run manually'
    case 'interval':
      return `every ${t.every === 1 ? t.unit.replace(/s$/, '') : `${t.every} ${t.unit}`}`
    case 'cron':
      return `on schedule ${t.schedule}`
    case 'commit':
      return `after commits, at most every ${t.cooldownMinutes} min`
  }
}

export function intervalMs(trigger: { every: number; unit: 'minutes' | 'hours' | 'days' }): number {
  const unit = trigger.unit === 'minutes' ? 60_000 : trigger.unit === 'hours' ? 3_600_000 : 86_400_000
  return Math.max(1, trigger.every) * unit
}

/**
 * The background agents that apply to a project: each attached template, with the project's
 * trigger override when it has one. Attachments to templates that no longer exist are
 * dropped, so a deleted template silently stops running rather than crashing the tick.
 */
export function resolveProjectJobs(project: Pick<Project, 'backgroundJobs'>, templates: BackgroundAgentTemplate[]): BackgroundJob[] {
  const byId = new Map(templates.map((t) => [t.id, t]))
  const out: BackgroundJob[] = []
  for (const attached of project.backgroundJobs ?? []) {
    const template = byId.get(attached.template)
    if (!template) continue
    out.push({ ...template, enabled: attached.enabled, trigger: attached.trigger ?? template.trigger, workspace: attached.workspace ?? template.workspace ?? 'worktree', customTrigger: Boolean(attached.trigger) })
  }
  return out
}

/** Expands the agent-profile placeholders in an argument list. A known key with no value becomes empty; anything else is left as written. */
export function expandArgs(args: string[], values: Record<string, string | undefined>): string[] {
  return args.map((arg) => arg.replace(/\{(prompt|cwd|sessionId|sourceSessionId|sauronBin)\}/g, (_m, key: string) => values[key] ?? ''))
}

/**
 * Before background agents were shared, each project carried full job definitions. Hoists
 * those into templates and leaves attachments behind. Returns the templates to save; the
 * projects are rewritten in place. A no-op when nothing is in the old shape.
 */
export function migrateLegacyProjectJobs(projects: Pick<Project, 'backgroundJobs'>[], templates: BackgroundAgentTemplate[]): { templates: BackgroundAgentTemplate[]; migrated: number } {
  const out = [...templates]
  let migrated = 0
  for (const project of projects) {
    if (!project.backgroundJobs?.length) continue
    project.backgroundJobs = project.backgroundJobs.map((entry) => {
      const legacy = entry as unknown as Partial<BackgroundAgentTemplate> & { enabled?: boolean; template?: string }
      if (typeof legacy.template === 'string' || typeof legacy.id !== 'string') return entry
      migrated++
      if (!out.some((t) => t.id === legacy.id)) {
        out.push({ id: legacy.id, name: legacy.name ?? legacy.id, agentId: legacy.agentId ?? 'claude', promptFile: legacy.promptFile ?? '', trigger: legacy.trigger ?? { kind: 'manual' }, skipIfUnchanged: legacy.skipIfUnchanged ?? true, autoMerge: legacy.autoMerge })
      }
      return { template: legacy.id, enabled: legacy.enabled ?? true, trigger: legacy.trigger }
    })
  }
  return { templates: out, migrated }
}
