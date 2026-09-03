export type EntryKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system'

export interface TranscriptEntry {
  /** Stable within a file: record index. */
  index: number
  timestamp: string | null
  kind: EntryKind
  text: string
  /** For tool calls: tool name and a one-line summary of the input. */
  tool?: { name: string; summary: string }
  isError?: boolean
}

export interface TranscriptHeader {
  sessionId: string | null
  cwd: string | null
  /** ISO timestamp of the first record, when known. */
  startedAt: string | null
}

export interface TranscriptPage {
  entries: TranscriptEntry[]
  /** Total parsed entries in the file so far. */
  total: number
}
