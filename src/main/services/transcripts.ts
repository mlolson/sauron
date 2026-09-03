import { createReadStream, existsSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { parserFor, type TranscriptParser } from '@shared/transcripts'
import type { TranscriptEntry, TranscriptHeader } from '@shared/transcript-types'
import type { AgentTool } from '@shared/types'

export interface TranscriptFile {
  path: string
  tool: AgentTool
  header: TranscriptHeader
  /** File modification time, ms since epoch. */
  mtimeMs: number
  sizeBytes: number
}

/** Reads only the first records of a transcript to learn its cwd and session id. */
export async function readTranscriptHeader(path: string, tool: AgentTool, maxBytes = 256 * 1024): Promise<TranscriptHeader> {
  const parser = parserFor(tool)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of text.split('\n')) {
      parser.parseLine(line)
      if (parser.header.sessionId && parser.header.cwd) break
    }
  } finally {
    await handle.close()
  }
  return parser.header
}

/**
 * Finds every Claude and Codex transcript on disk and keeps headers cached by path.
 * Calls `onChange` (debounced) when the transcript directories change.
 */
export class TranscriptIndexer {
  private cache = new Map<string, TranscriptFile>()
  private watchers: FSWatcher[] = []
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private readonly onChange: () => void,
    private readonly home = homedir(),
  ) {}

  get claudeRoot() {
    return join(this.home, '.claude', 'projects')
  }
  get codexRoot() {
    return join(this.home, '.codex', 'sessions')
  }

  start(): void {
    for (const root of [this.claudeRoot, this.codexRoot]) {
      if (!existsSync(root)) continue
      try {
        const w = watch(root, { recursive: true }, () => this.scheduleChange())
        w.on('error', (e) => console.warn('transcript watcher error', root, e.message))
        this.watchers.push(w)
      } catch (error) {
        console.warn('cannot watch', root, error)
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
  }

  private scheduleChange(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.onChange(), 1000)
  }

  /** Scans both roots. Headers are read only for new files; mtimes are refreshed for all. */
  async scan(): Promise<TranscriptFile[]> {
    const found: TranscriptFile[] = []
    const seen = new Set<string>()
    const visit = async (path: string, tool: AgentTool) => {
      seen.add(path)
      let s
      try {
        s = await stat(path)
      } catch {
        return
      }
      const cached = this.cache.get(path)
      if (cached && (cached.header.sessionId && cached.header.cwd)) {
        cached.mtimeMs = s.mtimeMs
        cached.sizeBytes = s.size
        found.push(cached)
        return
      }
      try {
        const header = await readTranscriptHeader(path, tool)
        const file: TranscriptFile = { path, tool, header, mtimeMs: s.mtimeMs, sizeBytes: s.size }
        this.cache.set(path, file)
        found.push(file)
      } catch (error) {
        console.warn('cannot read transcript header', path, error)
      }
    }

    if (existsSync(this.claudeRoot)) {
      for (const dir of await readdir(this.claudeRoot, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        const dirPath = join(this.claudeRoot, dir.name)
        for (const f of await readdir(dirPath)) {
          if (f.endsWith('.jsonl')) await visit(join(dirPath, f), 'claude')
        }
      }
    }
    if (existsSync(this.codexRoot)) {
      const walk = async (dir: string, depth: number) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          if (e.isDirectory() && depth < 4) await walk(p, depth + 1)
          else if (e.isFile() && e.name.endsWith('.jsonl')) await visit(p, 'codex')
        }
      }
      await walk(this.codexRoot, 0)
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path)
    return found
  }
}

export interface TailerHandlers {
  onEntries: (entries: TranscriptEntry[]) => void
}

/** Follows one transcript file, parsing new lines as they are appended. */
export class TranscriptTailer {
  private parser: TranscriptParser
  private offset = 0
  private remainder = ''
  private watcher: FSWatcher | null = null
  private reading: Promise<void> = Promise.resolve()
  private pendingRead = false
  entries: TranscriptEntry[] = []

  constructor(
    readonly path: string,
    readonly tool: AgentTool,
    private readonly handlers: TailerHandlers,
  ) {
    this.parser = parserFor(tool)
  }

  get header(): TranscriptHeader {
    return this.parser.header
  }

  /** Parses the whole file once, then watches for appends. */
  async start(): Promise<void> {
    await this.readAll()
    try {
      this.watcher = watch(this.path, () => this.scheduleRead())
      this.watcher.on('error', (e) => console.warn('tailer watch error', this.path, e.message))
    } catch (error) {
      console.warn('cannot watch transcript', this.path, error)
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private scheduleRead(): void {
    if (this.pendingRead) return
    this.pendingRead = true
    this.reading = this.reading.then(async () => {
      this.pendingRead = false
      const added = await this.readNew()
      if (added.length) this.handlers.onEntries(added)
    })
  }

  private async readAll(): Promise<void> {
    const stream = createReadStream(this.path, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      this.offset += Buffer.byteLength(line, 'utf8') + 1
      this.entries.push(...this.parser.parseLine(line))
    }
  }

  /** Reads bytes appended since the last read; a partial last line is kept for next time. */
  private async readNew(): Promise<TranscriptEntry[]> {
    let s
    try {
      s = await stat(this.path)
    } catch {
      return []
    }
    if (s.size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0
      this.remainder = ''
      this.entries = []
      this.parser = parserFor(this.tool)
    }
    if (s.size === this.offset) return []
    const handle = await open(this.path, 'r')
    try {
      const length = s.size - this.offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, this.offset)
      this.offset = s.size
      const text = this.remainder + buffer.toString('utf8')
      const lines = text.split('\n')
      this.remainder = lines.pop() ?? ''
      const added: TranscriptEntry[] = []
      for (const line of lines) added.push(...this.parser.parseLine(line))
      this.entries.push(...added)
      return added
    } finally {
      await handle.close()
    }
  }
}
