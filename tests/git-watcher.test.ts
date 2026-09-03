import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWatcher } from '../src/main/services/git-watcher'
import { checkCommand } from '../src/main/services/command'

const git = (cwd: string, ...args: string[]) => checkCommand('/usr/bin/git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })

describe('GitWatcher', () => {
  it('reports once for a burst of commits and not for no-op changes', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'sauron-gw-'))
    try {
      await git(repo, 'init', '-q', '-b', 'main')
      await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
      const reports: string[] = []
      const watcher = new GitWatcher('/usr/bin/git', repo, (fp) => reports.push(fp), 200)
      await watcher.start()
      for (let i = 0; i < 3; i++) {
        await writeFile(join(repo, `f${i}.txt`), String(i))
        await git(repo, 'add', '.')
        await git(repo, 'commit', '-q', '-m', `c${i}`)
      }
      await new Promise((r) => setTimeout(r, 700))
      expect(reports.length).toBe(1)
      expect(reports[0]).toMatch(/^main [0-9a-f]{40}$/)

      // Touching a file without committing must not report.
      await writeFile(join(repo, 'scratch.txt'), 'x')
      await watcher.check()
      expect(reports.length).toBe(1)
      watcher.stop()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
