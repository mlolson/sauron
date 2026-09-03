import { describe, expect, it } from 'vitest'
import { shellCommandLine } from '@shared/tmux-args'

describe('shellCommandLine', () => {
  it('quotes only what needs quoting', () => {
    expect(shellCommandLine(['/usr/local/bin/claude', '--session-id', 'abc', "fix the bug in it's file"])).toBe(
      `/usr/local/bin/claude --session-id abc 'fix the bug in it'\\''s file'`,
    )
  })
})
