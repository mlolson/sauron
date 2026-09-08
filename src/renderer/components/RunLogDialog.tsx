import { useState } from 'react'
import type { JobRun } from '@shared/types'

export function useRunLog() {
  const [logFor, setLogFor] = useState<{ run: JobRun; text: string | null } | null>(null)

  const showLog = async (run: JobRun) => {
    setLogFor({ run, text: null })
    const text = await window.sauron.runLog(run.id)
    setLogFor((cur) => (cur?.run.id === run.id ? { run, text } : cur))
  }
  const closeLog = () => setLogFor(null)

  return { logFor, showLog, closeLog }
}

export function RunLogDialog({ name, text, onClose }: { name: string; text: string | null; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal log-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{name} · log</h2></header>
        <pre className="run-log">{text === null ? 'Loading…' : text || '(empty)'}</pre>
        <div className="actions right"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
