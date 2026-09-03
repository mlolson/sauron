import { describe, expect, it } from 'vitest'
import { defaultWorktreeBranch, isValidBranchName, parseWorktreeList, worktreeDirName } from '@shared/worktrees'
import { WorktreeService } from '../src/main/services/worktrees'
import { checkCommand } from '../src/main/services/command'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('parseWorktreeList', () => {
  it('parses porcelain output and flags sauron worktrees', () => {
    const out = `worktree /code/repo
HEAD aaaa
branch refs/heads/main

worktree /base/repo/sauron-abcd1234
HEAD bbbb
branch refs/heads/sauron/abcd1234

worktree /elsewhere/detached
HEAD cccc
detached
`
    expect(parseWorktreeList(out, '/base/repo')).toEqual([
      { path: '/code/repo', branch: 'main', head: 'aaaa', isMain: true, isSauron: false },
      { path: '/base/repo/sauron-abcd1234', branch: 'sauron/abcd1234', head: 'bbbb', isMain: false, isSauron: true },
      { path: '/elsewhere/detached', branch: null, head: 'cccc', isMain: false, isSauron: false },
    ])
  })
})

describe('naming', () => {
  it('derives branch and directory names', () => {
    expect(defaultWorktreeBranch('abcdef12-3456-7890-abcd-ef1234567890')).toBe('sauron/abcdef12')
    expect(worktreeDirName('sauron/abcdef12')).toBe('sauron-abcdef12')
    expect(worktreeDirName('feature/x y!')).toBe('feature-x-y')
  })
  it('validates branch names', () => {
    expect(isValidBranchName('sauron/abc')).toBe(true)
    expect(isValidBranchName('-bad')).toBe(false)
    expect(isValidBranchName('a..b')).toBe(false)
    expect(isValidBranchName('')).toBe(false)
  })
})

describe('WorktreeService', () => {
  it('creates, inspects, and removes a worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sauron-wt-'))
    const repo = join(root, 'repo')
    const base = join(root, 'worktrees')
    try {
      await checkCommand('/bin/mkdir', ['-p', repo])
      await checkCommand('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: repo })
      await checkCommand('/usr/bin/git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
      const svc = new WorktreeService('/usr/bin/git', base)
      const dir = await svc.create(repo, 'repo', 'sauron/test1234')
      expect(dir).toBe(join(base, 'repo', 'sauron-test1234'))
      const list = await svc.list(repo, 'repo')
      expect(list.map((w) => [w.branch, w.isSauron])).toEqual([['main', false], ['sauron/test1234', true]])

      expect(await svc.safety(repo, dir)).toEqual({ dirty: false, unmergedCommits: 0 })
      await writeFile(join(dir, 'f.txt'), 'x')
      expect((await svc.safety(repo, dir)).dirty).toBe(true)
      await checkCommand('/usr/bin/git', ['add', '.'], { cwd: dir })
      await checkCommand('/usr/bin/git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'], { cwd: dir })
      expect(await svc.safety(repo, dir)).toEqual({ dirty: false, unmergedCommits: 1 })

      await svc.remove(repo, dir, false)
      expect((await svc.list(repo, 'repo')).length).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
