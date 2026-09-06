import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeRunIntoProject } from '../src/main/services/job-runner'
import type { JobRun, Project } from '../src/shared/types'

const GIT = '/usr/bin/git'
const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))

/** A repo with a run branch in a worktree, holding one commit on top of main. */
async function setup(): Promise<{ project: Project; run: JobRun; base: string; git: (...a: string[]) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sauron-merge-')); dirs.push(dir)
  const base = await mkdtemp(join(tmpdir(), 'sauron-merge-wt-')); dirs.push(base)
  const git = (...a: string[]) => execFileSync(GIT, ['-C', dir, ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 't')
  await writeFile(join(dir, 'f.txt'), 'base\n'); git('add', '-A'); git('commit', '-q', '-m', 'base')
  const baseCommit = git('rev-parse', 'HEAD').trim()
  const branch = 'sauron/bg/job/1'
  const worktreePath = join(base, 'proj', 'wt')
  git('worktree', 'add', '-q', '-b', branch, worktreePath)
  await writeFile(join(worktreePath, 'g.txt'), 'from the run\n')
  execFileSync(GIT, ['-C', worktreePath, 'add', '-A']); execFileSync(GIT, ['-C', worktreePath, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'run work'])
  const project = { id: 'p', name: 'proj', path: dir, addedAt: '', pinned: false, archived: false } as Project
  const run = { id: 'r', jobId: 'job', projectId: 'p', sessionId: 's', tmuxName: 't', branch, worktreePath, baseCommit, trigger: 'manual', startedAt: '', finishedAt: null, status: 'needs_review', summary: null, exitCode: 0, logPath: '', commitCount: 1 } as JobRun
  return { project, run, base, git }
}

describe('mergeRunIntoProject', () => {
  it('merges a clean run with --no-ff and removes its branch and worktree', async () => {
    const { project, run, base, git } = await setup()
    expect(await mergeRunIntoProject(GIT, base, project, run, 'Job')).toEqual({ merged: true })
    expect(git('log', '-1', '--format=%s').trim()).toBe('Merge background run: Job')
    expect(git('log', '--oneline').split('\n').filter(Boolean)).toHaveLength(3)
    expect(git('branch', '--list', run.branch).trim()).toBe('')
    expect(git('worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('refuses when the branches conflict, touching nothing', async () => {
    const { project, run, base, git } = await setup()
    await writeFile(join(project.path, 'g.txt'), 'main wrote this first\n'); git('add', '-A'); git('commit', '-q', '-m', 'main side')
    const before = git('rev-parse', 'HEAD').trim()
    const result = await mergeRunIntoProject(GIT, base, project, run, 'Job')
    expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('conflicts') })
    expect(git('rev-parse', 'HEAD').trim()).toBe(before)
    expect(git('branch', '--list', run.branch).trim()).not.toBe('')
    expect(git('status', '--porcelain').trim()).toBe('')
  })

  it('refuses when the main checkout has uncommitted changes', async () => {
    const { project, run, base, git } = await setup()
    await writeFile(join(project.path, 'f.txt'), 'edited but not committed\n')
    const result = await mergeRunIntoProject(GIT, base, project, run, 'Job')
    expect(result).toMatchObject({ merged: false, reason: expect.stringContaining('uncommitted') })
    expect(git('log', '--oneline').split('\n').filter(Boolean)).toHaveLength(1)
  })
})
