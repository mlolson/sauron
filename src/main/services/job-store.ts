import { DatabaseSync } from 'node:sqlite'
import type { JobRun, JobRunStatus, JobTrigger } from '@shared/types'

/**
 * Background job runs. Written by the CLI runner (with the app open or closed) and read by
 * the app, so it lives in its own SQLite file with WAL rather than in sessions.json, which
 * the app owns outright.
 */
export class JobStore {
  private db: DatabaseSync | null = null

  constructor(private readonly path: string) {}

  open(): void {
    if (this.db) return
    this.db = new DatabaseSync(this.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tmux_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        exit_code INTEGER,
        log_path TEXT NOT NULL,
        commit_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, started_at);
      CREATE INDEX IF NOT EXISTS runs_job ON runs (job_id, started_at);
      CREATE TABLE IF NOT EXISTS job_state (
        job_id TEXT PRIMARY KEY,
        last_run_at TEXT,
        last_trigger_commit TEXT
      );
    `)
  }

  insert(run: JobRun): void {
    this.requireDb().prepare(`
      INSERT INTO runs (id, job_id, project_id, session_id, tmux_name, branch, worktree_path, base_commit, trigger,
                        started_at, finished_at, status, summary, exit_code, log_path, commit_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.jobId, run.projectId, run.sessionId, run.tmuxName, run.branch, run.worktreePath, run.baseCommit, run.trigger,
      run.startedAt, run.finishedAt, run.status, run.summary, run.exitCode, run.logPath, run.commitCount)
    this.requireDb().prepare(`
      INSERT INTO job_state (job_id, last_run_at) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET last_run_at = excluded.last_run_at
    `).run(run.jobId, run.startedAt)
  }

  finish(id: string, result: { status: JobRunStatus; summary: string | null; exitCode: number; commitCount: number; finishedAt: string }): void {
    this.requireDb().prepare('UPDATE runs SET status = ?, summary = ?, exit_code = ?, commit_count = ?, finished_at = ? WHERE id = ?')
      .run(result.status, result.summary, result.exitCode, result.commitCount, result.finishedAt, id)
  }

  setStatus(id: string, status: JobRunStatus): void {
    this.requireDb().prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id)
  }

  get(id: string): JobRun | null {
    const row = this.requireDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? toRun(row) : null
  }

  /** Newest first. */
  forProject(projectId: string, limit = 50): JobRun[] {
    const rows = this.requireDb().prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit) as unknown as Row[]
    return rows.map(toRun)
  }

  all(limit = 500): JobRun[] {
    const rows = this.requireDb().prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as Row[]
    return rows.map(toRun)
  }

  /** The in-progress run for a job, if any: one run per job at a time. */
  running(jobId: string): JobRun | null {
    const row = this.requireDb().prepare("SELECT * FROM runs WHERE job_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1").get(jobId) as unknown as Row | undefined
    return row ? toRun(row) : null
  }

  /**
   * Claims the next run of a job if none started since `cutoff`. Two hooks racing on a burst
   * of commits both ask; SQLite serialises the writes, so exactly one is told yes.
   */
  claim(jobId: string, now: string, cutoff: string): boolean {
    const db = this.requireDb()
    db.prepare('INSERT OR IGNORE INTO job_state (job_id, last_run_at) VALUES (?, NULL)').run(jobId)
    const result = db.prepare('UPDATE job_state SET last_run_at = ? WHERE job_id = ? AND (last_run_at IS NULL OR last_run_at < ?)').run(now, jobId, cutoff)
    return Number(result.changes) > 0
  }

  /** Whether a Sauron session id belongs to a background run. */
  isRunSession(sessionId: string): boolean {
    return Boolean(this.requireDb().prepare('SELECT 1 FROM runs WHERE session_id = ? LIMIT 1').get(sessionId))
  }

  lastRunAt(jobId: string): string | null {
    const row = this.requireDb().prepare('SELECT last_run_at FROM job_state WHERE job_id = ?').get(jobId) as { last_run_at: string | null } | undefined
    return row?.last_run_at ?? null
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('Job database is not open.')
    return this.db
  }
}

interface Row {
  id: string
  job_id: string
  project_id: string
  session_id: string
  tmux_name: string
  branch: string
  worktree_path: string
  base_commit: string
  trigger: string
  started_at: string
  finished_at: string | null
  status: string
  summary: string | null
  exit_code: number | null
  log_path: string
  commit_count: number
}

function toRun(r: Row): JobRun {
  return {
    id: r.id,
    jobId: r.job_id,
    projectId: r.project_id,
    sessionId: r.session_id,
    tmuxName: r.tmux_name,
    branch: r.branch,
    worktreePath: r.worktree_path,
    baseCommit: r.base_commit,
    trigger: r.trigger as JobTrigger['kind'],
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as JobRunStatus,
    summary: r.summary,
    exitCode: r.exit_code,
    logPath: r.log_path,
    commitCount: r.commit_count,
  }
}
