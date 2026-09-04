import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscriptEntries } from '../src/main/services/transcripts'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))))

const meta = (ordinal: number, id: string, fork?: { from: string; below: number }) =>
  JSON.stringify({ timestamp: 't', ordinal, type: 'session_meta', payload: { session_id: id, id, cwd: '/x', ...(fork ? { forked_from_id: fork.from, forked_from_ordinal_exclusive: fork.below } : {}) } })
const msg = (ordinal: number, type: 'UserMessage' | 'AgentMessage', text: string) =>
  JSON.stringify({ timestamp: 't', ordinal, type: 'event_msg', payload: { type: 'item_completed', item: { type, content: [{ text }] } } })

describe('readTranscriptEntries for Codex forks', () => {
  it('prepends the inherited history from the parent rollout, bounded by the fork ordinal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sauron-codex-'))
    dirs.push(root)
    const day = join(root, '2026', '09', '03')
    await mkdir(day, { recursive: true })
    const grand = join(day, 'rollout-2026-09-03T10-00-00-gggg.jsonl')
    const parent = join(day, 'rollout-2026-09-03T11-00-00-pppp.jsonl')
    const fork = join(day, 'rollout-2026-09-03T12-00-00-ffff.jsonl')
    // Grandparent: 4 records; the parent forked at ordinal 3, so "g-late" is not part of its history.
    await writeFile(grand, [meta(0, 'gggg'), msg(1, 'UserMessage', 'g-user'), msg(2, 'AgentMessage', 'g-agent'), msg(3, 'AgentMessage', 'g-late')].join('\n') + '\n')
    // Parent: continues at ordinal 3 (its own), forked at 5 by the child, so "p-late" is excluded too.
    await writeFile(parent, [meta(3, 'pppp', { from: 'gggg', below: 3 }), msg(4, 'UserMessage', 'p-user'), msg(5, 'AgentMessage', 'p-late')].join('\n') + '\n')
    await writeFile(fork, [meta(5, 'ffff', { from: 'pppp', below: 5 }), msg(6, 'UserMessage', 'f-user')].join('\n') + '\n')

    const entries = await readTranscriptEntries(fork, 'codex', root)
    expect(entries.map((e) => e.text)).toEqual(['g-user', 'g-agent', 'p-user', 'f-user'])
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3])
  })

  it('reads an unforked rollout as before, and tolerates a missing parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sauron-codex-'))
    dirs.push(root)
    const plain = join(root, 'rollout-2026-09-03T10-00-00-aaaa.jsonl')
    await writeFile(plain, [meta(0, 'aaaa'), msg(1, 'UserMessage', 'hello')].join('\n') + '\n')
    expect((await readTranscriptEntries(plain, 'codex', root)).map((e) => e.text)).toEqual(['hello'])

    const orphan = join(root, 'rollout-2026-09-03T10-00-00-bbbb.jsonl')
    await writeFile(orphan, [meta(9, 'bbbb', { from: 'gone', below: 9 }), msg(10, 'UserMessage', 'only-mine')].join('\n') + '\n')
    expect((await readTranscriptEntries(orphan, 'codex', root)).map((e) => e.text)).toEqual(['only-mine'])
  })
})
