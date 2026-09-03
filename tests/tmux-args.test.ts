import { describe, expect, it } from 'vitest'
import { attachArgs, newSessionArgs, shellQuote, tmuxSessionName, tmuxTarget } from '@shared/tmux-args'

describe('tmuxSessionName', () => {
  it('is prefixed, slugged, and short-id suffixed', () => {
    expect(tmuxSessionName('My Repo.v2', 'abcdef12-0000-0000-0000-000000000000')).toBe('sauron-my-repo-v2-abcdef12')
  })
  it('never contains . or :', () => {
    const name = tmuxSessionName('a.b:c', 'ffffffff-1111-2222-3333-444444444444')
    expect(name).not.toMatch(/[.:]/)
  })
})

describe('newSessionArgs', () => {
  it('quotes the command and sorts environment', () => {
    expect(
      newSessionArgs({
        name: 'sauron-x-1',
        workingDir: '/tmp/repo',
        environment: { ZED: '1', ALPHA: 'a b' },
        command: ['/usr/local/bin/claude', '--name', "it's here"],
      }),
    ).toEqual(['new-session', '-d', '-s', 'sauron-x-1', '-c', '/tmp/repo', '-e', 'ALPHA=a b', '-e', 'ZED=1', "/usr/local/bin/claude --name 'it'\\''s here'"])
  })
})

describe('shellQuote', () => {
  it('leaves safe words alone', () => {
    expect(shellQuote('--session-id=abc-123')).toBe('--session-id=abc-123')
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('a b')).toBe("'a b'")
  })
})

describe('targets', () => {
  it('uses exact-match session targets', () => {
    expect(tmuxTarget('sauron-a-1')).toBe('=sauron-a-1:')
    expect(attachArgs('sauron-a-1')).toEqual(['attach-session', '-t', '=sauron-a-1:'])
  })
})
