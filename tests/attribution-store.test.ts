import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttributionStore } from '../src/main/services/attribution-store'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

describe('AttributionStore', () => {
  it('persists and updates commit attribution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sauron-attribution-'))
    dirs.push(dir)
    const path = join(dir, 'attributions.sqlite')
    const first = new AttributionStore(path)
    first.open()
    expect(first.get('p1', 'abc')).toBeNull()
    first.set('p1', 'abc', 's1')
    expect(first.get('p1', 'abc')).toBe('s1')
    first.set('p1', 'abc', 's2')
    first.close()

    const reopened = new AttributionStore(path)
    reopened.open()
    expect(reopened.get('p1', 'abc')).toBe('s2')
    expect(reopened.get('p2', 'abc')).toBeNull()
    reopened.close()
  })
})

describe('latestPerSession', () => {
  it('returns the most recent commit for each session, scoped to the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sauron-attribution-'))
    dirs.push(dir)
    const store = new AttributionStore(join(dir, 'attributions.sqlite'))
    store.open()
    store.set('p1', 'a'.repeat(40), 's1')
    store.set('p1', 'b'.repeat(40), 's1')
    store.set('p1', 'c'.repeat(40), 's2')
    store.set('p2', 'd'.repeat(40), 's1')

    const latest = store.latestPerSession('p1')
    expect(latest.get('s1')).toBe('b'.repeat(40))
    expect(latest.get('s2')).toBe('c'.repeat(40))
    expect(store.latestPerSession('p2').get('s1')).toBe('d'.repeat(40))
    expect(store.latestPerSession('nope').size).toBe(0)
    store.close()
  })
})

describe('commitsForSession', () => {
  it('lists a session\'s commits newest first across projects, honouring the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sauron-attribution-'))
    dirs.push(dir)
    const store = new AttributionStore(join(dir, 'attributions.sqlite'))
    store.open()
    store.set('p1', 'a'.repeat(40), 's1')
    store.set('p2', 'b'.repeat(40), 's1')
    store.set('p1', 'c'.repeat(40), 's1')
    store.set('p1', 'd'.repeat(40), 's2')
    expect(store.commitsForSession('s1', 10)).toEqual(['c'.repeat(40), 'b'.repeat(40), 'a'.repeat(40)])
    expect(store.commitsForSession('s1', 2)).toEqual(['c'.repeat(40), 'b'.repeat(40)])
    expect(store.commitsForSession('nobody', 10)).toEqual([])
    store.close()
  })
})
