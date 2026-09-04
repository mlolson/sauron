import { describe, expect, it } from 'vitest'
import { HANDOFF_MAX_MESSAGES, renderHandoff, tailEntries } from '../src/shared/handoff'
import type { TranscriptEntry } from '../src/shared/transcript-types'

const entry = (index: number, kind: TranscriptEntry['kind'], text: string, tool?: TranscriptEntry['tool']): TranscriptEntry =>
  ({ index, timestamp: null, kind, text, ...(tool ? { tool } : {}) })

const base = {
  sourceName: 'Claude 2',
  sourceTool: 'claude',
  targetName: 'Codex',
  cwd: '/code/app',
  branch: 'feature/x',
  commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', title: 'Add the thing', authoredAt: '2026-09-03T20:00:00Z' }],
  gitStatus: ' M src/index.ts\n?? notes.md\n',
}

describe('tailEntries', () => {
  it('keeps the last N messages and the tool calls among them, dropping tool results', () => {
    const entries: TranscriptEntry[] = []
    for (let i = 0; i < 120; i++) {
      entries.push(entry(i * 3, i % 2 ? 'assistant' : 'user', `m${i}`))
      entries.push(entry(i * 3 + 1, 'tool_call', '', { name: 'Bash', summary: `cmd${i}` }))
      entries.push(entry(i * 3 + 2, 'tool_result', 'huge output'))
    }
    const kept = tailEntries(entries, 50)
    expect(kept.filter((e) => e.kind === 'user' || e.kind === 'assistant')).toHaveLength(50)
    expect(kept.some((e) => e.kind === 'tool_result')).toBe(false)
    expect(kept[0]!.text).toBe('m70')
    expect(kept.at(-1)!.tool?.summary).toBe('cmd119')
  })

  it('returns everything when under the limit', () => {
    const entries = [entry(0, 'user', 'hi'), entry(1, 'assistant', 'hello')]
    expect(tailEntries(entries, 50)).toEqual(entries)
  })
})

describe('renderHandoff', () => {
  it('includes state, commits, and conversation', () => {
    const doc = renderHandoff({ ...base, entries: [entry(0, 'user', 'Fix the bug'), entry(1, 'tool_call', '', { name: 'Edit', summary: 'src/index.ts' }), entry(2, 'assistant', 'Done.')] })
    expect(doc).toContain('# Handoff to Codex')
    expect(doc).toContain('`/code/app`')
    expect(doc).toContain('`feature/x`')
    expect(doc).toContain(' M src/index.ts')
    expect(doc).toContain('`aaaaaaa` Add the thing')
    expect(doc).toContain('**User**:\n\nFix the bug')
    expect(doc).toContain('- _[Edit]_ src/index.ts')
    expect(doc).toContain('**Assistant**:\n\nDone.')
    expect(doc).not.toContain('omitted')
  })

  it('says so when there is no transcript, no commits, and a clean tree', () => {
    const doc = renderHandoff({ ...base, entries: [], commits: [], gitStatus: '' })
    expect(doc).toContain('No transcript was available')
    expect(doc).toContain('None recorded')
    expect(doc).toContain('working tree is clean')
  })

  it('reports how many earlier messages were dropped and truncates long ones', () => {
    const entries = Array.from({ length: HANDOFF_MAX_MESSAGES + 7 }, (_, i) => entry(i, 'user', i === HANDOFF_MAX_MESSAGES + 6 ? 'x'.repeat(5000) : `m${i}`))
    const doc = renderHandoff({ ...base, entries })
    expect(doc).toContain(`_7 earlier messages omitted; the last ${HANDOFF_MAX_MESSAGES} are shown._`)
    expect(doc).toContain('3000 more characters omitted')
    expect(doc).not.toContain('m6\n')
  })
})
