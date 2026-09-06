import { describe, expect, it } from 'vitest'
import { cooldownCutoff, dueCommitJobs } from '../src/shared/triggers'
import type { BackgroundJob } from '../src/shared/types'

const job = (id: string, over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id, name: id, enabled: true, agentId: 'claude', promptFile: 'p.md', trigger: { kind: 'commit', cooldownMinutes: 30 }, skipIfUnchanged: false, ...over,
})
const now = new Date('2026-09-05T12:00:00Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

describe('dueCommitJobs', () => {
  it('starts a commit-triggered job that has never run', () => {
    expect(dueCommitJobs([job('a')], { running: new Set(), lastRunAt: new Map() }, now).map((j) => j.id)).toEqual(['a'])
  })

  it('ignores disabled jobs and other trigger kinds', () => {
    const jobs = [job('off', { enabled: false }), job('cron', { trigger: { kind: 'cron', schedule: '* * * * *' } }), job('manual', { trigger: { kind: 'manual' } }), job('yes')]
    expect(dueCommitJobs(jobs, { running: new Set(), lastRunAt: new Map() }, now).map((j) => j.id)).toEqual(['yes'])
  })

  it('skips a job with a run in progress, and one still cooling down', () => {
    const state = { running: new Set(['busy']), lastRunAt: new Map([['recent', minutesAgo(10)], ['old', minutesAgo(31)]]) }
    expect(dueCommitJobs([job('busy'), job('recent'), job('old')], state, now).map((j) => j.id)).toEqual(['old'])
  })

  it('spaces runs by at least the burst window even with a zero cooldown', () => {
    const zero = job('z', { trigger: { kind: 'commit', cooldownMinutes: 0 } })
    expect(dueCommitJobs([zero], { running: new Set(), lastRunAt: new Map([['z', minutesAgo(0.5)]]) }, now)).toHaveLength(0)
    expect(dueCommitJobs([zero], { running: new Set(), lastRunAt: new Map([['z', minutesAgo(1)]]) }, now)).toHaveLength(1)
    expect(cooldownCutoff(zero as BackgroundJob & { trigger: { kind: 'commit' } }, now)).toBe('2026-09-05T11:59:00.000Z')
  })

  it('computes the cutoff a claim must beat', () => {
    expect(cooldownCutoff(job('a') as BackgroundJob & { trigger: { kind: 'commit' } }, now)).toBe('2026-09-05T11:30:00.000Z')
  })
})
