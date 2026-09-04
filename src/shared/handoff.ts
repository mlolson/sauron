import type { TranscriptEntry } from './transcript-types'
import type { SessionCommit } from './types'

/**
 * Renders the briefing one agent reads when it takes over from another.
 *
 * Agents cannot read each other's session stores, so a cross-agent handoff is a briefed
 * restart rather than a fork. This is deliberately mechanical: no model in the loop, so it is
 * instant and free. The working tree carries most of the real state anyway; what has to be
 * written down is the task, the decisions, and what is in flight.
 */

export interface HandoffInput {
  sourceName: string
  sourceTool: string
  targetName: string
  cwd: string
  branch: string | null
  /** Every parsed entry; the renderer keeps the tail. */
  entries: TranscriptEntry[]
  /** Newest first. */
  commits: SessionCommit[]
  /** `git status --short` output, possibly empty. */
  gitStatus: string
}

/** How many user and assistant messages to keep. Tool calls inside that window ride along. */
export const HANDOFF_MAX_MESSAGES = 50
/** Long messages are usually pasted logs or file dumps; the head is what matters. */
const MAX_MESSAGE_CHARS = 2000

export function renderHandoff(input: HandoffInput): string {
  const kept = tailEntries(input.entries, HANDOFF_MAX_MESSAGES)
  const dropped = countMessages(input.entries) - countMessages(kept)
  const lines: string[] = [
    `# Handoff to ${input.targetName}`,
    '',
    `You are taking over work from a **${input.sourceName}** session (${input.sourceTool}). Its conversation`,
    'is below, oldest first. The working tree is shared: everything it changed is on disk, so read',
    'the code rather than trusting this summary where they disagree. Continue the work; do not',
    'start over.',
    '',
    '## Where things stand',
    '',
    `- Directory: \`${input.cwd}\``,
    `- Branch: ${input.branch ? `\`${input.branch}\`` : 'unknown'}`,
    '',
  ]

  lines.push('### Uncommitted changes', '')
  if (input.gitStatus.trim()) lines.push('```', input.gitStatus.trimEnd(), '```')
  else lines.push('_None. The working tree is clean._')
  lines.push('')

  lines.push(`### Commits made by the previous session${input.commits.length ? ` (last ${input.commits.length})` : ''}`, '')
  if (input.commits.length) {
    for (const commit of input.commits) lines.push(`- \`${commit.shortHash}\` ${commit.title} — ${commit.authoredAt}`)
  } else {
    lines.push('_None recorded._')
  }
  lines.push('')

  lines.push('## Conversation', '')
  if (kept.length === 0) {
    lines.push('_No transcript was available for the previous session._')
  } else {
    if (dropped > 0) lines.push(`_${dropped} earlier message${dropped === 1 ? '' : 's'} omitted; the last ${HANDOFF_MAX_MESSAGES} are shown._`, '')
    for (const entry of kept) lines.push(...renderEntry(entry), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Keeps the last `max` user/assistant messages plus the tool calls interleaved among them.
 * Tool results are dropped outright: bulky, and their effects are on disk.
 */
export function tailEntries(entries: TranscriptEntry[], max: number): TranscriptEntry[] {
  const relevant = entries.filter((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool_call')
  let seen = 0
  let start = relevant.length
  for (let i = relevant.length - 1; i >= 0; i--) {
    if (relevant[i]!.kind !== 'tool_call') {
      if (seen === max) break
      seen++
    } else if (seen === max) {
      // A tool call older than the oldest kept message belongs to a dropped turn.
      continue
    }
    start = i
  }
  return relevant.slice(start)
}

function countMessages(entries: TranscriptEntry[]): number {
  return entries.filter((e) => e.kind === 'user' || e.kind === 'assistant').length
}

function renderEntry(entry: TranscriptEntry): string[] {
  if (entry.kind === 'tool_call') {
    const name = entry.tool?.name ?? 'tool'
    const summary = entry.tool?.summary ?? entry.text
    return [`- _[${name}]_ ${truncate(summary.replace(/\s+/g, ' ').trim(), 200)}`]
  }
  const label = entry.kind === 'user' ? '**User**' : '**Assistant**'
  return [`${label}:`, '', truncate(entry.text.trim(), MAX_MESSAGE_CHARS)]
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… _[${text.length - max} more characters omitted]_`
}
