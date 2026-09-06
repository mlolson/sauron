import { DatabaseSync } from 'node:sqlite'

/** Durable commit-to-session attribution, kept separate from session lifecycle JSON. */
export class AttributionStore {
  private db: DatabaseSync | null = null

  constructor(private readonly path: string) {}

  open(): void {
    if (this.db) return
    this.db = new DatabaseSync(this.path)
    this.db.exec(`
      -- Several processes write here (the app and post-commit hooks); wait for a lock rather than failing at once.
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS commit_attributions (
        project_id TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, commit_hash)
      );
      CREATE INDEX IF NOT EXISTS commit_attributions_session
        ON commit_attributions (session_id);
    `)
  }

  set(projectId: string, commitHash: string, sessionId: string): void {
    this.requireDb().prepare(`
      INSERT INTO commit_attributions (project_id, commit_hash, session_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, commit_hash) DO UPDATE SET
        session_id = excluded.session_id,
        created_at = excluded.created_at
    `).run(projectId, commitHash, sessionId, new Date().toISOString())
  }

  get(projectId: string, commitHash: string): string | null {
    const row = this.requireDb().prepare(
      'SELECT session_id FROM commit_attributions WHERE project_id = ? AND commit_hash = ?',
    ).get(projectId, commitHash) as { session_id: string } | undefined
    return row?.session_id ?? null
  }

  /** The most recently recorded commit for each session in a project. */
  latestPerSession(projectId: string): Map<string, string> {
    const rows = this.requireDb().prepare(
      // rowid breaks ties: two commits recorded in the same millisecond are entirely possible.
      'SELECT session_id, commit_hash FROM commit_attributions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
    ).all(projectId) as { session_id: string; commit_hash: string }[]
    const latest = new Map<string, string>()
    for (const row of rows) if (!latest.has(row.session_id)) latest.set(row.session_id, row.commit_hash)
    return latest
  }

  /** Commits a session made, newest first, across every project. */
  commitsForSession(sessionId: string, limit: number): string[] {
    const rows = this.requireDb().prepare(
      'SELECT commit_hash FROM commit_attributions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(sessionId, limit) as { commit_hash: string }[]
    return rows.map((row) => row.commit_hash)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('Attribution database is not open.')
    return this.db
  }
}
