import { describe, expect, it } from 'vitest'
import { describeTrigger, expandArgs, expandJobPrompt, jobIdOfBranch, attachToAllProjects, ensureBuiltInTemplates, migrateLegacyProjectJobs, projectSummarizerTemplate, resolveProjectJobs, runBranchName, runOutcome, slugifyJobId, summarizeAgentOutput } from '../src/shared/jobs'

describe('run branches', () => {
  it('names branches by job and timestamp, and reads the job back', () => {
    const branch = runBranchName('security-review', new Date('2026-09-05T03:04:05.678Z'))
    expect(branch).toBe('sauron/bg/security-review/20260905-030405Z')
    expect(jobIdOfBranch(branch)).toBe('security-review')
    expect(jobIdOfBranch('main')).toBeNull()
    expect(jobIdOfBranch('sauron/abc123')).toBeNull()
  })
})

describe('prompts and arguments', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    const out = expandJobPrompt('Review {projectName} at {projectPath} on {branch} for {jobName}; keep {unknown}.', {
      projectName: 'sauron', projectPath: '/code/sauron', branch: 'sauron/bg/x/1', jobName: 'Security',
    })
    expect(out).toBe('Review sauron at /code/sauron on sauron/bg/x/1 for Security; keep {unknown}.')
  })

  it('expands agent arguments the same way the app does', () => {
    // Known placeholders expand, a known one with no value empties, and an unknown one stays visible.
    expect(expandArgs(['-p', '{prompt}', '--cwd', '{cwd}', '{sauronBin}', '{missing}'], { prompt: 'do it', cwd: '/w' })).toEqual(['-p', 'do it', '--cwd', '/w', '', '{missing}'])
  })
})

describe('outcomes', () => {
  it('classifies a finished run', () => {
    expect(runOutcome(1, 3)).toBe('failed')
    expect(runOutcome(0, 0)).toBe('no_changes')
    expect(runOutcome(0, 2)).toBe('needs_review')
    // A main-checkout run has nothing to review however much it did.
    expect(runOutcome(0, 0, 'main')).toBe('done')
    expect(runOutcome(0, 5, 'main')).toBe('done')
    expect(runOutcome(2, 0, 'main')).toBe('failed')
  })
})

describe('summaries', () => {
  it("reads Claude's JSON result", () => {
    const out = 'noise\n' + JSON.stringify({ type: 'result', result: '  Fixed three typos.  ', cost_usd: 0.01 })
    expect(summarizeAgentOutput(out)).toBe('Fixed three typos.')
  })

  it('falls back to the last lines of plain output, and truncates', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const summary = summarizeAgentOutput(lines)
    expect(summary.split('\n')).toHaveLength(12)
    expect(summary.endsWith('line 29')).toBe(true)
    expect(summarizeAgentOutput('x'.repeat(5000), 100)).toHaveLength(101)
    expect(summarizeAgentOutput('   ')).toBe('')
  })
})

describe('ids and labels', () => {
  it('slugifies names into safe ids', () => {
    expect(slugifyJobId('Security Review!')).toBe('security-review')
    expect(slugifyJobId('   ')).toBe('job')
    expect(slugifyJobId('a'.repeat(60))).toHaveLength(40)
  })

  it('describes triggers', () => {
    const base = { id: 'j', name: 'J', enabled: true, agentId: 'claude', promptFile: 'p.md', skipIfUnchanged: true }
    expect(describeTrigger({ ...base, trigger: { kind: 'manual' } })).toBe('run manually')
    expect(describeTrigger({ ...base, trigger: { kind: 'cron', schedule: '0 3 * * *' } })).toBe('on schedule 0 3 * * *')
    expect(describeTrigger({ ...base, trigger: { kind: 'commit', cooldownMinutes: 30 } })).toBe('after commits, at most every 30 min')
  })
})

describe('describeTrigger for intervals', () => {
  it('reads naturally for one unit and for several', () => {
    expect(describeTrigger({ trigger: { kind: 'interval', every: 1, unit: 'days' } })).toBe('every day')
    expect(describeTrigger({ trigger: { kind: 'interval', every: 1, unit: 'hours' } })).toBe('every hour')
    expect(describeTrigger({ trigger: { kind: 'interval', every: 30, unit: 'minutes' } })).toBe('every 30 minutes')
  })
})

describe('resolveProjectJobs', () => {
  const tidy = { id: 'tidy', name: 'Tidy', agentId: 'claude', promptFile: 'tidy.md', trigger: { kind: 'interval', every: 1, unit: 'days' } as const, skipIfUnchanged: true }
  const review = { id: 'review', name: 'Review', agentId: 'codex', promptFile: 'review.md', trigger: { kind: 'manual' } as const, skipIfUnchanged: false, autoMerge: true }

  it('applies each attached template with the project override where there is one', () => {
    const jobs = resolveProjectJobs({ backgroundJobs: [{ template: 'review', enabled: false }, { template: 'tidy', enabled: true, trigger: { kind: 'commit', cooldownMinutes: 5 } }] }, [tidy, review])
    expect(jobs.map((j) => j.id)).toEqual(['review', 'tidy'])
    expect(jobs[0]).toMatchObject({ enabled: false, customTrigger: false, trigger: { kind: 'manual' }, autoMerge: true })
    expect(jobs[1]).toMatchObject({ enabled: true, customTrigger: true, trigger: { kind: 'commit', cooldownMinutes: 5 }, agentId: 'claude', workspace: 'worktree' })
  })

  it('drops attachments whose template is gone, and handles a project with none', () => {
    expect(resolveProjectJobs({ backgroundJobs: [{ template: 'deleted', enabled: true }] }, [tidy])).toEqual([])
    expect(resolveProjectJobs({}, [tidy])).toEqual([])
  })
})

describe('migrateLegacyProjectJobs', () => {
  it('hoists old per-project jobs into templates and leaves attachments', () => {
    const project = { backgroundJobs: [{ id: 'tidy', name: 'Tidy', enabled: false, agentId: 'codex', promptFile: 't.md', trigger: { kind: 'cron', schedule: '0 3 * * *' }, skipIfUnchanged: true } as never] }
    const result = migrateLegacyProjectJobs([project], [])
    expect(result.migrated).toBe(1)
    expect(result.templates).toEqual([{ id: 'tidy', name: 'Tidy', agentId: 'codex', promptFile: 't.md', trigger: { kind: 'cron', schedule: '0 3 * * *' }, skipIfUnchanged: true, autoMerge: undefined }])
    expect(project.backgroundJobs).toEqual([{ template: 'tidy', enabled: false, trigger: { kind: 'cron', schedule: '0 3 * * *' } }])
  })

  it('leaves the new shape alone', () => {
    const project = { backgroundJobs: [{ template: 'tidy', enabled: true }] }
    expect(migrateLegacyProjectJobs([project], []).migrated).toBe(0)
    expect(project.backgroundJobs).toEqual([{ template: 'tidy', enabled: true }])
  })
})

describe('resolveProjectJobs workspaces', () => {
  const t = { id: 'sum', name: 'Sum', agentId: 'claude', promptFile: 's.md', trigger: { kind: 'manual' } as const, skipIfUnchanged: true, workspace: 'main' as const }
  it('takes the template workspace, overridden per project, defaulting to a worktree', () => {
    expect(resolveProjectJobs({ backgroundJobs: [{ template: 'sum', enabled: true }] }, [t])[0]?.workspace).toBe('main')
    expect(resolveProjectJobs({ backgroundJobs: [{ template: 'sum', enabled: true, workspace: 'worktree' }] }, [t])[0]?.workspace).toBe('worktree')
    expect(resolveProjectJobs({ backgroundJobs: [{ template: 'sum', enabled: true }] }, [{ ...t, workspace: undefined }])[0]?.workspace).toBe('worktree')
  })
})

describe('built-in templates', () => {
  it('adds the summarizer when missing and keeps an edited one', () => {
    const fresh = ensureBuiltInTemplates([])
    expect(fresh.added).toBe(1)
    expect(fresh.templates[0]).toMatchObject({ id: 'project-summarizer', workspace: 'main', builtIn: true, trigger: { kind: 'commit', cooldownMinutes: 5 } })
    const edited = { ...projectSummarizerTemplate(), agentId: 'codex' }
    const again = ensureBuiltInTemplates([edited])
    expect(again.added).toBe(0)
    expect(again.templates).toEqual([edited])
  })

  it('attaches to every project that lacks it, once', () => {
    const projects = [{ backgroundJobs: [{ template: 'project-summarizer', enabled: false }] }, { backgroundJobs: [{ template: 'tidy', enabled: true }] }, {}] as { backgroundJobs?: { template: string; enabled: boolean }[] }[]
    expect(attachToAllProjects(projects, 'project-summarizer')).toBe(2)
    expect(projects[0]!.backgroundJobs).toEqual([{ template: 'project-summarizer', enabled: false }])
    expect(projects[1]!.backgroundJobs).toEqual([{ template: 'tidy', enabled: true }, { template: 'project-summarizer', enabled: true }])
    expect(attachToAllProjects(projects, 'project-summarizer')).toBe(0)
  })
})

describe('expandJobPrompt extras', () => {
  it('fills the summarizer placeholders and leaves unknown ones alone', () => {
    expect(expandJobPrompt('{projectId} since {previousSummaryUpdatedAt} {other}', { projectName: 'n', projectPath: '/p', branch: 'b', jobName: 'j', projectId: 'id1', previousSummaryUpdatedAt: 'never' })).toBe('id1 since never {other}')
    expect(expandJobPrompt('{projectId}', { projectName: 'n', projectPath: '/p', branch: 'b', jobName: 'j' })).toBe('{projectId}')
  })
})
