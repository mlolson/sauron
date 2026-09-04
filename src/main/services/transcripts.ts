import { createReadStream, existsSync, watch, type FSWatcher } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { parserFor, type TranscriptParser } from '@shared/transcripts'
import type { TranscriptEntry, TranscriptHeader } from '@shared/transcript-types'
type TranscriptTool = 'claude' | 'codex'

export interface TranscriptFile {
  path: string
  tool: TranscriptTool
  header: TranscriptHeader
  /** File modification time, ms since epoch. */
  mtimeMs: number
  sizeBytes: number
}

/**
 * Parses a whole transcript once, for handoffs, which need the conversation rather than a live
 * tail. A Codex fork's rollout holds only what was said after the fork; the inherited history
 * stays in the parent rollout, named by `forked_from_id` in the fork's session_meta. Ordinals
 * run in one sequence across the chain, so an ancestor contributes its records below the
 * child's `forked_from_ordinal_exclusive`, and its own parent is followed the same way.
 */
export async function readTranscriptEntries(path: string, tool: TranscriptTool, codexRoot = join(homedir(), '.codex', 'sessions')): Promise<TranscriptEntry[]> {
  const parser = parserFor(tool)
  const entries: TranscriptEntry[] = []
  const files = tool === 'codex' ? await codexRolloutChain(path, codexRoot) : [{ path, below: Infinity }]
  // Oldest ancestor first, through one parser so indices stay monotonic.
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (file.below !== Infinity && !ordinalBelow(line, file.below)) continue
      entries.push(...parser.parseLine(line))
    }
  }
  return entries
}

/** The rollout and its ancestors, oldest first, each with the ordinal bound its descendant imposes. */
async function codexRolloutChain(path: string, codexRoot: string): Promise<{ path: string; below: number }[]> {
  const chain: { path: string; below: number }[] = [{ path, below: Infinity }]
  const seen = new Set([path])
  let current = path
  // Bounded so a corrupt session_meta cannot send this walking forever.
  for (let depth = 0; depth < 16; depth++) {
    const meta = await codexForkMeta(current)
    if (!meta) break
    const parent = await findCodexRollout(codexRoot, meta.parentId)
    if (!parent || seen.has(parent)) break
    seen.add(parent)
    chain.unshift({ path: parent, below: meta.below })
    current = parent
  }
  return chain
}

/** Reads a rollout's session_meta; null when it was not forked from another session. */
async function codexForkMeta(path: string): Promise<{ parentId: string; below: number } | null> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      const record = JSON.parse(line) as { type?: unknown; payload?: { forked_from_id?: unknown; forked_from_ordinal_exclusive?: unknown } }
      if (record.type !== 'session_meta') return null
      const { forked_from_id: parentId, forked_from_ordinal_exclusive: below } = record.payload ?? {}
      return typeof parentId === 'string' && typeof below === 'number' ? { parentId, below } : null
    }
  } finally {
    rl.close()
  }
  return null
}

/** Rollout files are named `rollout-<timestamp>-<session id>.jsonl`, so the id is the file's suffix. */
async function findCodexRollout(root: string, sessionId: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 6 || !existsSync(dir)) return null
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        const found = await walk(p, depth + 1)
        if (found) return found
      } else if (e.isFile() && e.name.endsWith(suffix)) {
        return p
      }
    }
    return null
  }
  return walk(root, 0)
}

function ordinalBelow(line: string, bound: number): boolean {
  try {
    const ordinal = (JSON.parse(line) as { ordinal?: unknown }).ordinal
    return typeof ordinal === 'number' && ordinal < bound
  } catch {
    return false
  }
}

/** Reads only the first records of a transcript to learn its cwd and session id. */
export async function readTranscriptHeader(path: string, tool: TranscriptTool, maxBytes = 256 * 1024): Promise<TranscriptHeader> {
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
    const visit = async (path: string, tool: TranscriptTool) => {
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
    readonly tool: TranscriptTool,
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
