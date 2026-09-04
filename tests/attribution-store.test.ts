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
