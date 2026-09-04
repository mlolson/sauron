import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { hashesOnBranch, listBranches, recentGitCommits } from '../src/main/services/git'

const GIT = '/usr/bin/git'
const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sauron-branch-'))
  dirs.push(dir)
  const git = (...a: string[]) => execFileSync(GIT, ['-C', dir, ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'a@b')
  git('config', 'user.name', 't')
  await writeFile(join(dir, 'f.txt'), 'base\n')
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'feature')
  await writeFile(join(dir, 'g.txt'), 'feature\n')
  git('add', '-A'); git('commit', '-q', '-m', 'on feature')
  git('checkout', '-q', 'main')
  await writeFile(join(dir, 'h.txt'), 'main only\n')
  git('add', '-A'); git('commit', '-q', '-m', 'on main')
  return dir
}

describe('branch filtering', () => {
  it('lists branches with the current one first', async () => {
    const dir = await repo()
    expect(await listBranches(GIT, dir)).toEqual(['main', 'feature'])
  })

  it('walks one branch when named, and everything otherwise', async () => {
    const dir = await repo()
    expect((await recentGitCommits(GIT, dir, 20)).map((c) => c.title).sort()).toEqual(['base', 'on feature', 'on main'])
    expect((await recentGitCommits(GIT, dir, 20, 'feature')).map((c) => c.title)).toEqual(['on feature', 'base'])
    expect((await recentGitCommits(GIT, dir, 20, 'main')).map((c) => c.title)).toEqual(['on main', 'base'])
  })

  it('reports which commits a branch contains, for filtering a session list', async () => {
    const dir = await repo()
    const all = await recentGitCommits(GIT, dir, 20)
    const onFeature = await hashesOnBranch(GIT, dir, 'feature')
    const titles = all.filter((c) => onFeature.has(c.hash)).map((c) => c.title).sort()
    expect(titles).toEqual(['base', 'on feature'])
    expect(await hashesOnBranch(GIT, dir, 'nope')).toEqual(new Set())
  })
})
