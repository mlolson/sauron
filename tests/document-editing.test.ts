import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { readDocument, writeDocument } from '../src/main/services/documents'
import { commitPath } from '../src/main/services/git'
import type { Project } from '../src/shared/types'

const GIT = '/usr/bin/git'
const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))

async function repo(): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), 'sauron-doc-'))
  dirs.push(dir)
  execFileSync(GIT, ['-C', dir, 'init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'NOTES.md'), '# Notes\n\noriginal\n')
  await writeFile(join(dir, 'OTHER.md'), 'untouched\n')
  execFileSync(GIT, ['-C', dir, 'add', '-A'])
  execFileSync(GIT, ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  return { id: 'p', name: 'p', path: dir, addedAt: '', pinned: false, archived: false } as Project
}

describe('document editing', () => {
  it('writes and reads back', async () => {
    const p = await repo()
    const before = await readDocument(p, 'NOTES.md')
    await writeDocument(p, 'NOTES.md', '# Notes\n\nedited\n', before.mtime)
    expect((await readDocument(p, 'NOTES.md')).content).toContain('edited')
  })

  it('refuses a write when the file changed since it was loaded', async () => {
    const p = await repo()
    const before = await readDocument(p, 'NOTES.md')
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(join(p.path, 'NOTES.md'), 'an agent wrote this\n')
    await expect(writeDocument(p, 'NOTES.md', 'my edit\n', before.mtime)).rejects.toThrow(/changed on disk/)
    expect((await readDocument(p, 'NOTES.md')).content).toBe('an agent wrote this\n')
  })

  it('refuses to escape the project directory', async () => {
    const p = await repo()
    await expect(writeDocument(p, '../escape.md', 'nope\n', null)).rejects.toThrow(/not inside/)
  })

  it('commits only the named path, leaving other staged work alone', async () => {
    const p = await repo()
    await writeFile(join(p.path, 'NOTES.md'), 'doc edit\n')
    await writeFile(join(p.path, 'OTHER.md'), 'unrelated staged change\n')
    execFileSync(GIT, ['-C', p.path, 'add', 'OTHER.md'])
    execFileSync(GIT, ['-C', p.path, 'config', 'user.email', 'a@b'])
    execFileSync(GIT, ['-C', p.path, 'config', 'user.name', 't'])

    const hash = await commitPath(GIT, p.path, 'NOTES.md', 'Update NOTES.md')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    const files = execFileSync(GIT, ['-C', p.path, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(files).toBe('NOTES.md')
    expect(execFileSync(GIT, ['-C', p.path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Update NOTES.md')
    expect(execFileSync(GIT, ['-C', p.path, 'status', '--short'], { encoding: 'utf8' })).toContain('OTHER.md')
  })

  it('reports a clear error when there is nothing to commit', async () => {
    const p = await repo()
    execFileSync(GIT, ['-C', p.path, 'config', 'user.email', 'a@b'])
    execFileSync(GIT, ['-C', p.path, 'config', 'user.name', 't'])
    await expect(commitPath(GIT, p.path, 'NOTES.md', 'no change')).rejects.toThrow(/no changes to commit/)
  })
})
