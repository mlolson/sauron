import { describe, expect, it } from 'vitest'
import { firstSentence, parseStatusFile, renderMasterClaudeMd } from '@shared/status'

describe('parseStatusFile', () => {
  it('accepts minimal and snake_case forms', () => {
    const s = parseStatusFile('p1', JSON.stringify({ summary: ' Hello. World. ', updated_at: '2026-09-03T00:00:00Z', head_commit: 'abc', recent_updates: '- a\n- b', todos: ['c'] }))
    expect(s).toMatchObject({ projectId: 'p1', summary: 'Hello.', recentUpdates: ['a', 'b'], todos: ['c'], details: null, updatedAt: '2026-09-03T00:00:00Z', headCommit: 'abc', source: 'master' })
  })
  it('keeps one sentence', () => {
    expect(firstSentence('Sauron is an app (v1.2) for agents. It also does more.')).toBe('Sauron is an app (v1.2) for agents.')
    expect(firstSentence('No terminal punctuation here')).toBe('No terminal punctuation here')
  })
  it('rejects garbage', () => {
    expect(parseStatusFile('p1', 'not json')).toBeNull()
    expect(parseStatusFile('p1', '{"details":"x"}')).toBeNull()
  })
})

describe('renderMasterClaudeMd', () => {
  it('lists projects and tool paths', () => {
    const md = renderMasterClaudeMd({
      projects: [{ id: 'p1', name: 'sauron', path: '/code/sauron' }],
      statusDir: '/as/status',
      sauronBin: '/as/bin/sauron',
      claudeTranscriptRoot: '/home/.claude/projects',
      codexSessionRoot: '/home/.codex/sessions',
    })
    expect(md).toContain('| sauron | `p1` | `/code/sauron` |')
    expect(md).toContain('/as/bin/sauron')
    expect(md).toContain('CLAUDE.local.md')
  })
})
