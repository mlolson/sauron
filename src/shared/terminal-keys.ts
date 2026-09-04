/** Pure key-encoding decisions for the embedded terminal, shared and unit-tested. */

export interface KeyEventLike {
  type: string
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * The bytes to send instead of xterm's own encoding, or null to let xterm handle the key.
 *
 * Shift+Enter is the case that needs help. xterm.js sends a bare CR for it — identical to
 * Enter — because it does not implement the kitty keyboard protocol that lets a terminal
 * report the two apart, so agents see "submit" where the user meant "newline". ESC+CR is the
 * encoding Claude Code's own terminal-setup installs for iTerm2 and VS Code; Codex accepts it
 * too, and zsh binds `\e^M` to self-insert-unmeta, so it inserts a newline in an agent and in
 * a plain shell alike. Option+Enter already produces these bytes through xterm's meta handling.
 */
export function overrideKeySequence(event: KeyEventLike): string | null {
  if (event.type !== 'keydown') return null
  // Any other modifier means the user asked for something else; leave those to xterm.
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null
  return '\x1b\r'
}
