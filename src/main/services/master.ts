import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { renderMasterClaudeMd } from '@shared/status'
import type { Project } from '@shared/types'

/** The supervisor agent's home directory: a generated CLAUDE.md plus whatever the user adds. */
export class MasterHome {
  constructor(readonly dir: string) {}

  get claudeMdPath(): string {
    return join(this.dir, 'CLAUDE.md')
  }

  get instructionsPath(): string {
    return join(this.dir, 'AGENTS.md')
  }

  /** Writes CLAUDE.md and returns a hash of its content. */
  async regenerate(projects: Project[], sauronBin: string): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const md = renderMasterClaudeMd({
      projects: projects.map(({ id, name, path }) => ({ id, name, path })),
      sauronBin,
      claudeTranscriptRoot: join(homedir(), '.claude', 'projects'),
      codexSessionRoot: join(homedir(), '.codex', 'sessions'),
    })
    await writeFile(this.claudeMdPath, md, 'utf8')
    // AGENTS.md is understood by Codex, OpenCode, Pi, and other agent CLIs. Keep the
    // Claude-specific filename too for backwards compatibility and native Claude loading.
    await writeFile(this.instructionsPath, md, 'utf8')
    return createHash('sha1').update(md).digest('hex')
  }
}

/**
 * Queue of projects whose summaries need refreshing. Duplicates collapse; nothing is sent
 * while the master is busy or a refresh is already in flight.
 */
