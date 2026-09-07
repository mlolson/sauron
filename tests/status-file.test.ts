import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSauronExcluded, migrateLegacyStatusFile, readStatusFile, statusFilePath, writeStatusFile } from '../src/main/services/status-file'
import { StatusStore } from '../src/main/services/status-store'
import type { ProjectStatus } from '../src/shared/status'

const GIT = process.env.SAURON_TOOL_GIT || 'git'
const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), 'sauron-status-')); dirs.push(d); return d }

const status = (projectId: string): ProjectStatus => ({ projectId, summary: 'One sentence.', recentUpdates: ['a'], todos: ['b'], details: null, updatedAt: '2026-09-07T00:00:00.000Z', headCommit: 'abc', source: 'master' })

describe('status file', () => {
  it('round-trips through <project>/.sauron/status.json without the project id', async () => {
    const project = await scratch()
    await writeStatusFile(project, status('p1'))
    const raw = JSON.parse(await readFile(statusFilePath(project), 'utf8'))
    expect(raw.projectId).toBeUndefined()
    expect(await readStatusFile('p1', project)).toEqual(status('p1'))
    expect(await readStatusFile('p1', await scratch())).toBeNull()
  })

  it('moves a legacy central file into the project once', async () => {
    const project = await scratch(); const central = await scratch()
    const legacy = join(central, 'p1.json')
    await writeFile(legacy, JSON.stringify({ summary: 'Old.' }))
    expect(await migrateLegacyStatusFile(legacy, project)).toBe(true)
    expect((await readStatusFile('p1', project))?.summary).toBe('Old.')
    expect(await migrateLegacyStatusFile(legacy, project)).toBe(false)
    // A file the project already has is never overwritten.
    await writeFile(legacy, JSON.stringify({ summary: 'Older.' }))
    expect(await migrateLegacyStatusFile(legacy, project)).toBe(false)
    expect((await readStatusFile('p1', project))?.summary).toBe('Old.')
  })
})

describe('ensureSauronExcluded', () => {
  it('makes git ignore .sauron/ via info/exclude, once, leaving .gitignore alone', async () => {
    const repo = await scratch()
    execFileSync(GIT, ['init', '-q', repo])
    await ensureSauronExcluded(GIT, repo)
    await ensureSauronExcluded(GIT, repo)
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l === '.sauron/')).toHaveLength(1)
    await mkdir(join(repo, '.sauron'), { recursive: true })
    await writeFile(join(repo, '.sauron', 'status.json'), '{}')
    expect(execFileSync(GIT, ['-C', repo, 'status', '--porcelain']).toString()).toBe('')
    expect(await readFile(join(repo, '.gitignore'), 'utf8').catch(() => 'absent')).toBe('absent')
  })

  it('does nothing when the repository already ignores it', async () => {
    const repo = await scratch()
    execFileSync(GIT, ['init', '-q', repo])
    await writeFile(join(repo, '.gitignore'), '.sauron/\n')
    await ensureSauronExcluded(GIT, repo)
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(() => '')).not.toContain('.sauron/')
  })
})

describe('StatusStore', () => {
  it('reads each project from its own directory and drops projects that leave', async () => {
    const a = await scratch(); const b = await scratch()
    await writeStatusFile(a, status('a'))
    const store = new StatusStore(() => undefined)
    await store.sync([{ id: 'a', path: a }, { id: 'b', path: b }])
    expect(Object.keys(store.statuses)).toEqual(['a'])
    await store.write(b, status('b'))
    expect(store.statuses.b?.summary).toBe('One sentence.')
    await store.sync([{ id: 'b', path: b }])
    expect(Object.keys(store.statuses)).toEqual(['b'])
    store.stop()
  })
})
