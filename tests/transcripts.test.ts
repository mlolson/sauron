import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeTranscriptParser, CodexRolloutParser, claudeTranscriptPath, encodeClaudeProjectPath, projectForCwd, summarizeToolInput } from '@shared/transcripts'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n')

describe('claude transcript paths', () => {
  it('encodes like Claude Code', () => {
    expect(encodeClaudeProjectPath('/Users/mattolson/code/sauron')).toBe('-Users-mattolson-code-sauron')
    expect(encodeClaudeProjectPath('/a/b.c_d')).toBe('-a-b-c-d')
  })
  it('builds the transcript path', () => {
    expect(claudeTranscriptPath('/home', '/x/y', 's1')).toBe('/home/.claude/projects/-x-y/s1.jsonl')
  })
})

describe('ClaudeTranscriptParser', () => {
  it('parses messages and tool calls, skips thinking, meta, and malformed lines', () => {
    const p = new ClaudeTranscriptParser()
    const entries = fixture('claude.jsonl').flatMap((l) => p.parseLine(l))
    expect(p.header).toEqual({ sessionId: 'aaaa-1111', cwd: '/Users/me/code/sauron', startedAt: '2026-09-03T19:00:00.000Z' })
    expect(entries.map((e) => [e.index, e.kind, e.text.slice(0, 20)])).toEqual([
      [0, 'user', 'Reply with PONG'],
      [1, 'tool_call', '{"command":"ls -la",'],
      [2, 'tool_result', 'total 0\nfile.txt'],
      [3, 'assistant', 'PONG'],
    ])
    expect(entries[1]!.tool).toEqual({ name: 'Bash', summary: 'List files' })
    expect(entries[2]!.isError).toBe(false)
  })
})

describe('CodexRolloutParser', () => {
  it('parses item_completed events and the session header', () => {
    const p = new CodexRolloutParser()
    const entries = fixture('codex.jsonl').flatMap((l) => p.parseLine(l))
    expect(p.header).toEqual({ sessionId: 'bbbb-2222', cwd: '/Users/me/code/sauron', startedAt: '2026-09-03T19:50:54.933Z' })
    expect(entries.map((e) => [e.kind, e.tool?.name ?? e.text])).toEqual([
      ['user', 'Reply with PONG'],
      ['tool_call', 'Command'],
      ['tool_result', '/Users/me/code/sauron\nfile.txt\n'],
      ['tool_call', 'Edit'],
      ['assistant', 'PONG'],
    ])
    expect(entries[1]!.tool?.summary).toBe('pwd && ls')
    expect(entries[3]!.tool?.summary).toBe('a.py')
  })
})

describe('summarizeToolInput', () => {
  it('summarizes common tools', () => {
    expect(summarizeToolInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
    expect(summarizeToolInput('Custom', { query: 'x', n: 1 })).toBe('query: x')
  })
})

describe('projectForCwd', () => {
  const projects = [{ id: 'p1', path: '/code/a' }, { id: 'p2', path: '/code/ab' }]
  const wts = { p1: ['/wt/a-branch'] }
  it('matches root, subdirectories, and worktrees but not prefixes', () => {
    expect(projectForCwd('/code/a', projects, wts)).toBe('p1')
    expect(projectForCwd('/code/a/src', projects, wts)).toBe('p1')
    expect(projectForCwd('/code/ab', projects, wts)).toBe('p2')
    expect(projectForCwd('/wt/a-branch/x', projects, wts)).toBe('p1')
    expect(projectForCwd('/code/other', projects, wts)).toBeNull()
  })
})
