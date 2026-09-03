/** Pure tmux argument builders, shared and unit-tested. */

export const TMUX_SESSION_PREFIX = 'sauron-'

/** Builds `sauron-<slug>-<short id>`. tmux forbids "." and ":" in names. */
export function tmuxSessionName(slug: string, id: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const short = id.replace(/-/g, '').slice(0, 8).toLowerCase()
  return `${TMUX_SESSION_PREFIX}${cleaned}-${short}`
}

/** Exact-match session target. tmux 3.6 accepts `=name:` everywhere; bare `=name` is not. */
export function tmuxTarget(name: string): string {
  return `=${name}:`
}

export function shellQuote(word: string): string {
  if (word === '') return "''"
  if (/^[A-Za-z0-9\-_./=:@%+,]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

export function newSessionArgs(opts: {
  name: string
  workingDir: string
  environment: Record<string, string>
  command: string[]
}): string[] {
  const args = ['new-session', '-d', '-s', opts.name, '-c', opts.workingDir]
  for (const key of Object.keys(opts.environment).sort()) {
    args.push('-e', `${key}=${opts.environment[key]}`)
  }
  // tmux runs the command through the user's shell, so quote each word.
  args.push(opts.command.map(shellQuote).join(' '))
  return args
}

export function attachArgs(name: string): string[] {
  return ['attach-session', '-t', tmuxTarget(name)]
}

/** Names of the tmux user options Sauron stamps on its sessions so they can be recovered. */
export const TMUX_OPTION_TITLE = '@sauron_title'
export const TMUX_OPTION_PROJECT = '@sauron_project'
export const TMUX_OPTION_SESSION = '@sauron_session'
export const TMUX_OPTION_TOOL = '@sauron_tool'

/** Builds a shell command line for typing into an interactive shell. */
export function shellCommandLine(words: string[]): string {
  return words.map(shellQuote).join(' ')
}
