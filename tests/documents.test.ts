import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listKeyDocuments, readDocument, relativeInside } from '../src/main/services/documents'
import type { Project } from '@shared/types'

async function makeProject(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'sauron-docs-'))
  await writeFile(join(root, 'README.md'), '# hi')
  await writeFile(join(root, 'ARCH.md'), 'x')
  await writeFile(join(root, 'notes.txt'), 'x')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'PLAN.md'), 'x')
  await mkdir(join(root, 'docs', 'deep'))
  await writeFile(join(root, 'docs', 'deep', 'TOO_DEEP.md'), 'x')
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'README.md'), 'x')
  return { id: 'p', name: 'p', path: root, addedAt: '', pinned: false }
}

describe('listKeyDocuments', () => {
  it('finds markdown at root and one level down, README first, skipping node_modules', async () => {
    const project = await makeProject()
    try {
      const docs = await listKeyDocuments(project)
      expect(docs.map((d) => [d.path, d.source])).toEqual([
        ['README.md', 'default'],
        ['ARCH.md', 'default'],
        ['docs/PLAN.md', 'default'],
      ])
    } finally {
      await rm(project.path, { recursive: true, force: true })
    }
  })
  it('honours included and excluded lists', async () => {
    const project = await makeProject()
    project.keyDocuments = { included: ['notes.txt', 'docs/deep/TOO_DEEP.md'], excluded: ['ARCH.md'] }
    try {
      const docs = await listKeyDocuments(project)
      expect(docs.map((d) => d.path)).toEqual(['README.md', 'notes.txt', 'docs/PLAN.md', 'docs/deep/TOO_DEEP.md'])
      expect(docs.find((d) => d.path === 'notes.txt')?.source).toBe('added')
    } finally {
      await rm(project.path, { recursive: true, force: true })
    }
  })
  it('reads documents only inside the project', async () => {
    const project = await makeProject()
    try {
      expect((await readDocument(project, 'README.md')).content).toBe('# hi')
      await expect(readDocument(project, '../etc/passwd')).rejects.toThrow(/not inside/)
      expect(() => relativeInside(project, '/etc/passwd')).toThrow(/not inside/)
      expect(relativeInside(project, join(project.path, 'docs', 'PLAN.md'))).toBe('docs/PLAN.md')
    } finally {
      await rm(project.path, { recursive: true, force: true })
    }
  })
})
