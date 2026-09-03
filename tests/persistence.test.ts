import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppPaths, Persistence, writeJsonAtomic } from '../src/main/services/persistence'
import { CONFIG_VERSION } from '@shared/types'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sauron-test-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('Persistence', () => {
  it('returns an empty config and creates the layout when nothing exists', async () => {
    const p = new Persistence(new AppPaths(root))
    expect(await p.loadConfig()).toEqual({ version: CONFIG_VERSION, projects: [] })
    expect(existsSync(join(root, 'status'))).toBe(true)
  })

  it('round-trips config', async () => {
    const p = new Persistence(new AppPaths(root), 10)
    const config = {
      version: CONFIG_VERSION,
      projects: [{ id: 'a', name: 'sauron', path: '/code/sauron', addedAt: '2026-09-03T00:00:00.000Z', pinned: true }],
    }
    p.saveConfig(config)
    await p.flush()
    expect(await p.loadConfig()).toEqual(config)
  })

  it('collapses debounced writes', async () => {
    const p = new Persistence(new AppPaths(root), 30)
    p.saveConfig({ version: CONFIG_VERSION, projects: [{ id: 'a', name: 'a', path: '/a', addedAt: '', pinned: false }] })
    p.saveConfig({ version: CONFIG_VERSION, projects: [{ id: 'b', name: 'b', path: '/b', addedAt: '', pinned: false }] })
    await new Promise((r) => setTimeout(r, 100))
    expect((await p.loadConfig()).projects.map((x) => x.name)).toEqual(['b'])
  })

  it('rejects a newer version', async () => {
    const paths = new AppPaths(root)
    await paths.createLayout()
    await writeJsonAtomic(paths.configFile, { version: CONFIG_VERSION + 1, projects: [] })
    await expect(new Persistence(paths).loadConfig()).rejects.toThrow(/newer/)
  })

  it('writes atomically with no temp files left behind', async () => {
    const file = join(root, 'x.json')
    await writeJsonAtomic(file, { a: 1 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
