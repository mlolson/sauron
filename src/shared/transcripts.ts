import type { EntryKind, TranscriptEntry, TranscriptHeader } from './transcript-types'

/**
 * Claude Code stores transcripts under ~/.claude/projects/<encoded cwd>/<session id>.jsonl,
 * where every character that is not a letter or digit is replaced by "-".
 */
export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${encodeClaudeProjectPath(cwd)}/${sessionId}.jsonl`
}

type Json = Record<string, unknown>

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

function str(v: unknown, max = Infinity): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function firstLine(s: string, max = 160): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** One-line description of a tool call's input, per well-known tool. */
export function summarizeToolInput(name: string, input: unknown): string {
  const o = asObject(input) ?? {}
  switch (name) {
    case 'Bash':
      return firstLine(str(o.description || o.command))
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str(o.file_path || o.notebook_path)
    case 'Glob':
    case 'Grep':
      return str(o.pattern) + (o.path ? ` in ${str(o.path)}` : '')
    case 'Agent':
    case 'Task':
      return str(o.description || o.prompt, 120)
    case 'WebFetch':
      return str(o.url)
    case 'WebSearch':
      return str(o.query)
    default: {
      const keys = Object.keys(o)
      if (keys.length === 0) return ''
      const k = keys.find((x) => typeof o[x] === 'string') ?? keys[0]!
      return `${k}: ${firstLine(str(o[k]), 100)}`
    }
  }
}

/** Streaming line-by-line parser. Feed complete lines; unknown records are skipped. */
export abstract class TranscriptParser {
  readonly header: TranscriptHeader = { sessionId: null, cwd: null, startedAt: null }
  private index = 0

  /** Parses one JSONL line into zero or more entries. Malformed lines are skipped. */
  parseLine(line: string): TranscriptEntry[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      return []
    }
    const obj = asObject(record)
    if (!obj) return []
    this.readHeader(obj)
    const entries = this.parseRecord(obj)
    for (const e of entries) e.index = this.index++
    return entries
  }

  protected abstract readHeader(record: Json): void
  protected abstract parseRecord(record: Json): TranscriptEntry[]

  protected entry(kind: EntryKind, text: string, timestamp: unknown, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return { index: 0, timestamp: typeof timestamp === 'string' ? timestamp : null, kind, text, ...extra }
  }
}

export class ClaudeTranscriptParser extends TranscriptParser {
  protected readHeader(r: Json): void {
    if (!this.header.sessionId && typeof r.sessionId === 'string') this.header.sessionId = r.sessionId
    if (!this.header.cwd && typeof r.cwd === 'string') this.header.cwd = r.cwd
    if (!this.header.startedAt && typeof r.timestamp === 'string') this.header.startedAt = r.timestamp
  }

  protected parseRecord(r: Json): TranscriptEntry[] {
    if (r.isMeta === true) return []
    const message = asObject(r.message)
    const ts = r.timestamp
    if (r.type === 'user' && message) {
      const content = message.content
      if (typeof content === 'string') return [this.entry('user', content, ts)]
      if (!Array.isArray(content)) return []
      const out: TranscriptEntry[] = []
      for (const block of content) {
        const b = asObject(block)
        if (!b) continue
        if (b.type === 'text') out.push(this.entry('user', str(b.text), ts))
        else if (b.type === 'tool_result') {
          const c = b.content
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => str(asObject(x)?.text ?? '')).join('\n') : str(c)
          out.push(this.entry('tool_result', text, ts, { isError: b.is_error === true }))
        }
      }
      return out
    }
    if (r.type === 'assistant' && message) {
      const content = message.content
      if (!Array.isArray(content)) return []
      const out: TranscriptEntry[] = []
      for (const block of content) {
        const b = asObject(block)
        if (!b) continue
        if (b.type === 'text') out.push(this.entry('assistant', str(b.text), ts))
        else if (b.type === 'tool_use') {
          const name = str(b.name)
          out.push(this.entry('tool_call', str(b.input), ts, { tool: { name, summary: summarizeToolInput(name, b.input) } }))
        }
      }
      return out
    }
    if (r.type === 'summary' && typeof r.summary === 'string') return [this.entry('system', `Summary: ${r.summary}`, ts)]
    return []
  }
}

export class CodexRolloutParser extends TranscriptParser {
  protected readHeader(r: Json): void {
    if (r.type !== 'session_meta') return
    const p = asObject(r.payload)
    if (!p) return
    if (typeof p.session_id === 'string') this.header.sessionId = p.session_id
    else if (typeof p.id === 'string') this.header.sessionId = p.id
    if (typeof p.cwd === 'string') this.header.cwd = p.cwd
    if (typeof p.timestamp === 'string') this.header.startedAt = p.timestamp
    else if (typeof r.timestamp === 'string') this.header.startedAt = r.timestamp
  }

  protected parseRecord(r: Json): TranscriptEntry[] {
    if (r.type !== 'event_msg') return []
    const p = asObject(r.payload)
    if (!p) return []
    const ts = r.timestamp
    if (p.type === 'item_completed') {
      const item = asObject(p.item)
      if (!item) return []
      const texts = (Array.isArray(item.content) ? item.content : [])
        .map((c) => asObject(c))
        .filter((c): c is Json => !!c && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
      switch (item.type) {
        case 'UserMessage':
          return [this.entry('user', texts, ts)]
        case 'AgentMessage':
          return [this.entry('assistant', texts, ts)]
        case 'CommandExecution': {
          const cmd = Array.isArray(item.command) ? item.command.map(String) : [str(item.command)]
          // Drop the shell wrapper (`/bin/zsh -lc <script>`) so the summary shows the script.
          const script = cmd.length >= 3 && /^-l?c$/.test(cmd[1] ?? '') ? cmd.slice(2).join(' ') : cmd.join(' ')
          const output = str(item.aggregated_output ?? item.output ?? '')
          const exit = typeof item.exit_code === 'number' ? item.exit_code : null
          const call = this.entry('tool_call', script, ts, { tool: { name: 'Command', summary: firstLine(script) } })
          const out: TranscriptEntry[] = [call]
          if (output || exit !== null) out.push(this.entry('tool_result', output || `(exit ${exit})`, ts, { isError: exit !== null && exit !== 0 }))
          return out
        }
        case 'FileChange': {
          const files = Object.keys(asObject(item.changes) ?? {})
          return [this.entry('tool_call', files.join('\n'), ts, { tool: { name: 'Edit', summary: files.map((f) => f.split('/').pop()).join(', ') } })]
        }
        case 'ContextCompaction':
          return [this.entry('system', 'Context compacted', ts)]
        default:
          return []
      }
    }
    if (p.type === 'task_complete' && typeof p.last_agent_message === 'string' && p.last_agent_message) {
      return [] // already shown as the final AgentMessage
    }
    return []
  }
}

export function parserFor(tool: 'claude' | 'codex'): TranscriptParser {
  return tool === 'claude' ? new ClaudeTranscriptParser() : new CodexRolloutParser()
}

/** Maps a transcript's cwd onto a project: the repo root, any subdirectory, or a worktree of it. */
export function projectForCwd(cwd: string, projects: { id: string; path: string }[], worktreePaths: Record<string, string[]>): string | null {
  const within = (dir: string) => cwd === dir || cwd.startsWith(dir.replace(/\/+$/, '') + '/')
  for (const p of projects) {
    if (within(p.path)) return p.id
    for (const wt of worktreePaths[p.id] ?? []) if (within(wt)) return p.id
  }
  return null
}
