import type { SessionState } from './types'

export interface HookEvent {
  tool: 'claude' | 'codex'
  event: string
  payload: Record<string, unknown>
}

export interface Transition {
  state: SessionState
  /** Something worth telling the user about when the session is not in front of them. */
  notify?: { title: string; body: string }
}

/**
 * Maps a hook event to the session's next state. Unknown events yield null (no change).
 *
 * Claude Code events: SessionStart, UserPromptSubmit, Notification, Stop, SessionEnd.
 * Codex notify: agent-turn-complete.
 */
export function transitionForHook(e: HookEvent, sessionName: string): Transition | null {
  if (e.tool === 'claude') {
    switch (e.event) {
      case 'SessionStart':
        return { state: 'idle' }
      case 'UserPromptSubmit':
        return { state: 'running' }
      case 'Notification': {
        const message = String(e.payload.message ?? e.payload.title ?? 'needs your attention')
        return { state: 'waitingForInput', notify: { title: `${sessionName} is waiting`, body: message } }
      }
      case 'Stop':
        return { state: 'idle', notify: { title: `${sessionName} finished`, body: 'The agent completed its turn.' } }
      case 'SessionEnd':
        return { state: 'stopped' }
      default:
        return null
    }
  }
  switch (e.event) {
    case 'agent-turn-complete': {
      const body = String(e.payload['last-assistant-message'] ?? e.payload.lastAssistantMessage ?? 'The agent completed its turn.')
      return { state: 'idle', notify: { title: `${sessionName} finished`, body: body.slice(0, 200) } }
    }
    default:
      return null
  }
}

/** Codex has no permission-prompt hook; recognise its approval prompts in the last screen lines. */
const APPROVAL_PATTERNS = [
  /\b(allow|approve|approval|permission)\b.*\?/i,
  /\[y\/n\]/i,
  /\byes\b.*\bno\b/i,
  /press enter to (continue|confirm)/i,
  /\(y\)es.*\(n\)o/i,
]

export function looksLikeApprovalPrompt(screenTail: string): boolean {
  const tail = screenTail.split('\n').filter((l) => l.trim()).slice(-12).join('\n')
  return APPROVAL_PATTERNS.some((re) => re.test(tail))
}

/** Claude Code settings JSON that reports every relevant hook event to Sauron. */
export function claudeHookSettings(sauronBin: string): object {
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: `${shellQuoteSimple(sauronBin)} hook claude ${event}` }] }]
  return {
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      Notification: hook('Notification'),
      Stop: hook('Stop'),
      SessionEnd: hook('SessionEnd'),
    },
  }
}

function shellQuoteSimple(s: string): string {
  return /^[A-Za-z0-9\-_./]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Codex `notify` config value: an argv array Codex appends the JSON payload to. */
export function codexNotifyConfig(sauronBin: string): string {
  return `notify=${JSON.stringify([sauronBin, 'hook', 'codex'])}`
}
