import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobStore } from '../src/main/services/job-store'
import type { JobRun } from '../src/shared/types'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))

const run = (over: Partial<JobRun> = {}): JobRun => ({
  id: 'r1', jobId: 'cleanup', projectId: 'p1', sessionId: 's1', tmuxName: 'sauron-bg-cleanup-s1',
  branch: 'sauron/bg/cleanup/20260905-000000Z', worktreePath: '/wt/r1', baseCommit: 'a'.repeat(40),
  trigger: 'manual', startedAt: '2026-09-05T00:00:00.000Z', finishedAt: null, status: 'running',
  summary: null, exitCode: null, logPath: '/logs/r1.log', commitCount: 0, ...over,
})

describe('JobStore', () => {
  it('round-trips a run and records the job state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sauron-jobs-')); dirs.push(dir)
    const store = new JobStore(join(dir, 'jobs.sqlite')); store.open()
    store.insert(run())
    expect(store.get('r1')).toEqual(run())
    expect(store.lastRunAt('cleanup')).toBe('2026-09-05T00:00:00.000Z')
    expect(store.running('cleanup')?.id).toBe('r1')
    store.finish('r1', { status: 'needs_review', summary: 'Tidied.', exitCode: 0, commitCount: 2, finishedAt: '2026-09-05T00:05:00.000Z' })
    expect(store.get('r1')).toMatchObject({ status: 'needs_review', summary: 'Tidied.', exitCode: 0, commitCount: 2 })
    expect(store.running('cleanup')).toBeNull()
    store.setStatus('r1', 'merged')
    expect(store.get('r1')?.status).toBe('merged')
    store.close()
  })

  it('lists a project newest first and survives reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sauron-jobs-')); dirs.push(dir)
    const path = join(dir, 'jobs.sqlite')
    const a = new JobStore(path); a.open()
    a.insert(run({ id: 'old', startedAt: '2026-09-01T00:00:00.000Z' }))
    a.insert(run({ id: 'new', startedAt: '2026-09-04T00:00:00.000Z' }))
    a.insert(run({ id: 'other', projectId: 'p2' }))
    a.close()
    const b = new JobStore(path); b.open()
    expect(b.forProject('p1').map((r) => r.id)).toEqual(['new', 'old'])
    expect(b.forProject('p2').map((r) => r.id)).toEqual(['other'])
    expect(b.forProject('nope')).toEqual([])
    b.close()
  })
})
