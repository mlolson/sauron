import type { SessionState } from '@shared/types'

const labels: Record<SessionState, string> = {
  running: 'Running',
  waitingForInput: 'Waiting for input',
  idle: 'Idle',
  stopped: 'Stopped',
}

export function StateDot({ state }: { state: SessionState }) {
  return <span className={`dot ${state}`} title={labels[state]} />
}
