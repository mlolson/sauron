import type { Preferences, Session } from '@shared/types'

export function MasterView({ session, preferences }: { session: Session | undefined; preferences: Preferences }) {
  const profile = preferences.agents.find((agent) => agent.id === preferences.supervisorAgentId)
  return (
    <div className="placeholder">
      <div className="big">◉</div>
      <h2>Supervisor Agent</h2>
      <p>
        A long-lived {profile?.name ?? preferences.supervisorAgentId} session that keeps project summaries current and can start or direct worker sessions. It runs in its own
        home directory with generated CLAUDE.md and AGENTS.md instructions.
        {preferences.supervisorEnabled && session?.cliSessionId ? ' Starting will resume its previous conversation.' : ''}
        {!preferences.supervisorEnabled ? ' It is currently disabled, so it will not run or refresh summaries.' : ''}
      </p>
      <div className="actions">
        {preferences.supervisorEnabled ? (
          <button className="primary" onClick={() => void window.sauron.startMaster()}>
            {session?.cliSessionId ? 'Resume Supervisor Agent' : 'Start Supervisor Agent'}
          </button>
        ) : (
          <button className="primary" onClick={() => void window.sauron.setPreferences({ supervisorEnabled: true })}>
            Enable Supervisor Agent
          </button>
        )}
      </div>
    </div>
  )
}
