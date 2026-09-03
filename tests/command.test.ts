import { describe, expect, it } from 'vitest'
import { checkCommand, runCommand } from '../src/main/services/command'
import { gitToplevel } from '../src/main/services/git'
import { findExecutable, loginShellPath } from '../src/main/services/cli-resolver'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('runCommand', () => {
  it('captures output and exit code', async () => {
    const r = await runCommand('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 3'])
    expect(r).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 3 })
  })
  it('returns when a grandchild keeps stdout open', async () => {
    const start = Date.now()
    const r = await runCommand('/bin/sh', ['-c', '(sleep 3 &); echo done'])
    expect(r.stdout).toBe('done\n')
    expect(Date.now() - start).toBeLessThan(2000)
  })
  it('checkCommand throws on failure', async () => {
    await expect(checkCommand('/bin/sh', ['-c', 'echo bad 1>&2; exit 1'])).rejects.toThrow(/status 1: bad/)
  })
})

describe('gitToplevel', () => {
  it('finds the root from a subdirectory and rejects non-repos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sauron-git-'))
    try {
      const sub = join(root, 'a', 'b')
      await mkdir(sub, { recursive: true })
      await checkCommand('/usr/bin/git', ['init', '-q'], { cwd: root })
      const { realpath } = await import('node:fs/promises')
      expect(await gitToplevel('/usr/bin/git', sub)).toBe(await realpath(root))
      const other = await mkdtemp(join(tmpdir(), 'sauron-notgit-'))
      await expect(gitToplevel('/usr/bin/git', other)).rejects.toThrow(/not inside a git repository/)
      await rm(other, { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cli resolver', () => {
  it('finds executables on a PATH', () => {
    expect(findExecutable('ls', '/nonexistent:/bin')).toBe('/bin/ls')
    expect(findExecutable('definitely-not-a-tool', '/bin')).toBeNull()
  })
  it('login shell PATH includes /usr/bin', async () => {
    expect(await loginShellPath()).toContain('/usr/bin')
  })
})
