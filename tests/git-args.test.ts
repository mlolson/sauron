import { describe, expect, it } from 'vitest'
import { gitSubcommand } from '../src/shared/git-args'

describe('gitSubcommand', () => {
  it('finds the subcommand past global options', () => {
    expect(gitSubcommand(['commit', '-m', 'x'])).toBe('commit')
    expect(gitSubcommand(['-C', '/tmp/repo', 'commit'])).toBe('commit')
    expect(gitSubcommand(['-c', 'user.name=commit', 'log'])).toBe('log')
    expect(gitSubcommand(['--git-dir', '/a/.git', '--no-pager', 'status'])).toBe('status')
  })

  it('does not mistake an option value or message for the subcommand', () => {
    expect(gitSubcommand(['log', '-1', '--format=commit %H'])).toBe('log')
    expect(gitSubcommand(['--version'])).toBeNull()
    expect(gitSubcommand([])).toBeNull()
  })
})
