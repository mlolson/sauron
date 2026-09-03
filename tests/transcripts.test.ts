import { describe, expect, it } from 'vitest'
import { claudeTranscriptPath, encodeClaudeProjectPath } from '@shared/transcripts'

describe('claude transcript paths', () => {
  it('encodes like Claude Code', () => {
    expect(encodeClaudeProjectPath('/Users/mattolson/code/sauron')).toBe('-Users-mattolson-code-sauron')
    expect(encodeClaudeProjectPath('/a/b.c_d')).toBe('-a-b-c-d')
  })
  it('builds the transcript path', () => {
    expect(claudeTranscriptPath('/home', '/x/y', 's1')).toBe('/home/.claude/projects/-x-y/s1.jsonl')
  })
})
