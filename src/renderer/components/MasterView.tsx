import type { Session } from '@shared/types'

export function MasterView({ session }: { session: Session | undefined }) {
  return (
    <div className="placeholder">
      <div className="big">◉</div>
      <h2>Master Agent</h2>
      <p>
        A long-lived Claude Code session that keeps project summaries current and can start or direct worker sessions. It runs in its own
        home directory with a generated CLAUDE.md.
        {session?.cliSessionId ? ' Starting will resume its previous conversation.' : ''}
      </p>
      <div className="actions">
        <button className="primary" onClick={() => void window.sauron.startMaster()}>
          {session?.cliSessionId ? 'Resume Master Agent' : 'Start Master Agent'}
        </button>
      </div>
    </div>
  )
}
